import type { Pool } from "pg";
import type { RecoveryMetrics } from "../recovery/metrics.js";
import { createMetricsRegistry, type MetricsRegistry } from "./metrics-registry.js";

/**
 * The names of the eight metrics `createEngineMetrics` registers.
 */
export const ENGINE_METRIC_NAMES = [
  "dee_queue_depth",
  "dee_task_latency_seconds",
  "dee_step_retries_total",
  "dee_timer_lag_seconds",
  "dee_active_workers",
  "dee_runs",
  "dee_tasks_quarantined",
  "dee_leases_reclaimed_total",
] as const;

/**
 * The bucket upper bounds, in seconds, of `dee_task_latency_seconds`.
 */
export const TASK_LATENCY_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

/**
 * How a task ended, as recorded in `dee_task_latency_seconds`.
 */
export type TaskOutcome = "completed" | "failed";

/**
 * Options for `createEngineMetrics`. `recovery` adds the janitor's reclaimed
 * lease count; `clock` supplies "now" for the timer lag.
 */
export interface EngineMetricsOptions {
  readonly registry?: MetricsRegistry;
  readonly recovery?: RecoveryMetrics;
  readonly clock?: { now(): Date };
}

/**
 * The engine's metrics. Gauges and the retry and quarantine counts are read
 * from Postgres on every `render`, so every process sees the whole fleet;
 * the latency histogram is filled in process by `observeTaskLatency`.
 */
export interface EngineMetrics {
  readonly registry: MetricsRegistry;
  /**
   * Records how long a task took from becoming visible to being settled.
   */
  observeTaskLatency(queueName: string, outcome: TaskOutcome, seconds: number): void;
  render(): Promise<string>;
}

const RUN_STATUSES = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "TERMINATED",
] as const;

/**
 * Registers the engine metrics over `pool`.
 */
export function createEngineMetrics(pool: Pool, options: EngineMetricsOptions = {}): EngineMetrics {
  const registry = options.registry ?? createMetricsRegistry();
  const clock = options.clock ?? { now: () => new Date() };

  const queueDepth = registry.gauge({
    name: "dee_queue_depth",
    help: "Tasks waiting to be leased, by queue.",
  });
  const latency = registry.histogram({
    name: "dee_task_latency_seconds",
    help: "Seconds from a task becoming visible to the worker settling it.",
    buckets: TASK_LATENCY_BUCKETS,
  });
  const retries = registry.counter({
    name: "dee_step_retries_total",
    help: "Failed step attempts that were scheduled for another try.",
  });
  const timerLag = registry.gauge({
    name: "dee_timer_lag_seconds",
    help: "Seconds the oldest due timer has waited to fire, 0 when none is overdue.",
  });
  const activeWorkers = registry.gauge({
    name: "dee_active_workers",
    help: "Distinct workers currently holding a task lease.",
  });
  const runs = registry.gauge({
    name: "dee_runs",
    help: "Workflow runs by status.",
  });
  const quarantined = registry.gauge({
    name: "dee_tasks_quarantined",
    help: "Tasks parked as poison, by queue.",
  });
  const reclaimed = registry.counter({
    name: "dee_leases_reclaimed_total",
    help: "Expired leases the janitor took back, since this process started.",
  });

  registry.beforeRender(async () => {
    const now = clock.now();

    const depth = await pool.query<{ queue_name: string; depth: string }>(
      `select queue_name, count(*) as depth from tasks
       where state = 'PENDING' and visible_at <= $1 group by queue_name`,
      [now],
    );
    queueDepth.clear();
    for (const row of depth.rows) {
      queueDepth.set({ queue: row.queue_name }, Number(row.depth));
    }

    const parked = await pool.query<{ queue_name: string; parked: string }>(
      `select queue_name, count(*) as parked from tasks
       where state = 'QUARANTINED' group by queue_name`,
    );
    quarantined.clear();
    for (const row of parked.rows) {
      quarantined.set({ queue: row.queue_name }, Number(row.parked));
    }

    const lag = await pool.query<{ lag: string | null }>(
      `select extract(epoch from ($1::timestamptz - min(fire_at))) as lag from timers
       where state = 'PENDING' and fire_at <= $1`,
      [now],
    );
    timerLag.set({}, Math.max(0, Number(lag.rows[0]?.lag ?? 0)));

    const workers = await pool.query<{ workers: string }>(
      `select count(distinct leased_by) as workers from tasks
       where state = 'LEASED' and leased_by is not null`,
    );
    activeWorkers.set({}, Number(workers.rows[0]?.workers ?? 0));

    const byStatus = await pool.query<{ status: string; total: string }>(
      "select status, count(*) as total from workflow_runs group by status",
    );
    runs.clear();
    for (const status of RUN_STATUSES) {
      runs.set({ status }, 0);
    }
    for (const row of byStatus.rows) {
      runs.set({ status: row.status }, Number(row.total));
    }

    const retried = await pool.query<{ total: string }>(
      "select count(*) as total from step_attempts where retry_at is not null",
    );
    retries.set({}, Number(retried.rows[0]?.total ?? 0));

    reclaimed.set({}, options.recovery?.snapshot().leasesReclaimed ?? 0);
  });

  return {
    registry,
    observeTaskLatency(queueName, outcome, seconds): void {
      latency.observe({ queue: queueName, outcome }, Math.max(0, seconds));
    },
    render: () => registry.render(),
  };
}
