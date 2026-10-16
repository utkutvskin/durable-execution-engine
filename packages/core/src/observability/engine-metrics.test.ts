import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createTaskQueue } from "../queue/task-queue.js";
import { createRecoveryMetrics } from "../recovery/metrics.js";
import { ENGINE_METRIC_NAMES, createEngineMetrics } from "./engine-metrics.js";
import { parsePrometheusText } from "./prometheus-text.js";

describe("engine metrics", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  const now = new Date("2026-05-01T12:00:00.000Z");
  const clock = { now: () => now };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const result = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = result.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  async function insertRun(status: string): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, status) values ($1, 'order', $2) returning id",
      [namespaceId, status],
    );
    return result.rows[0]?.id ?? "";
  }

  async function sample(
    name: string,
    labels: Record<string, string> = {},
    recovery = createRecoveryMetrics(),
  ): Promise<number | undefined> {
    const metrics = createEngineMetrics(database.pool, { clock, recovery });
    const parsed = parsePrometheusText(await metrics.render());
    return parsed.samples.find(
      (entry) =>
        entry.name === name &&
        Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
    )?.value;
  }

  it("exposes exactly the eight expected metrics in parseable prometheus format", async () => {
    const metrics = createEngineMetrics(database.pool, { clock });
    metrics.observeTaskLatency("default", "completed", 0.2);
    const parsed = parsePrometheusText(await metrics.render());
    expect([...parsed.types.keys()].sort()).toEqual([...ENGINE_METRIC_NAMES].sort());
    expect(ENGINE_METRIC_NAMES).toHaveLength(8);
    for (const name of ENGINE_METRIC_NAMES) {
      expect(parsed.help.get(name)).toBeTruthy();
    }
  });

  it("reports run counts by status, zero for statuses without runs", async () => {
    await insertRun("RUNNING");
    await insertRun("RUNNING");
    await insertRun("COMPLETED");
    expect(await sample("dee_runs", { status: "RUNNING" })).toBe(2);
    expect(await sample("dee_runs", { status: "COMPLETED" })).toBe(1);
    expect(await sample("dee_runs", { status: "FAILED" })).toBe(0);
  });

  it("reports the visible pending tasks per queue and ignores delayed ones", async () => {
    const runId = await insertRun("RUNNING");
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, visible_at)
       values ($1, $2, 'depth-q', 'WORKFLOW_TASK', $3), ($1, $2, 'depth-q', 'WORKFLOW_TASK', $3),
              ($1, $2, 'depth-q', 'WORKFLOW_TASK', $4)`,
      [namespaceId, runId, new Date(now.getTime() - 1000), new Date(now.getTime() + 3_600_000)],
    );
    expect(await sample("dee_queue_depth", { queue: "depth-q" })).toBe(2);
  });

  it("reports the age of the oldest overdue timer and zero when none is overdue", async () => {
    expect(await sample("dee_timer_lag_seconds")).toBe(0);
    const runId = await insertRun("RUNNING");
    await database.pool.query(
      "insert into timers (run_id, timer_id, fire_at) values ($1, 't1', $2), ($1, 't2', $3), ($1, 't3', $4)",
      [
        runId,
        new Date(now.getTime() - 90_000),
        new Date(now.getTime() - 10_000),
        new Date(now.getTime() + 60_000),
      ],
    );
    expect(await sample("dee_timer_lag_seconds")).toBe(90);
  });

  it("counts distinct workers that hold a lease", async () => {
    const runId = await insertRun("RUNNING");
    const queue = createTaskQueue(database.pool);
    const base = { namespaceId, runId, queueName: "workers-q", taskType: "WORKFLOW_TASK" } as const;
    for (let index = 0; index < 3; index += 1) {
      await queue.enqueue(base);
    }
    await queue.dequeue({ queueName: "workers-q", visibilityTimeoutMs: 60_000, workerId: "w1" });
    await queue.dequeue({ queueName: "workers-q", visibilityTimeoutMs: 60_000, workerId: "w1" });
    await queue.dequeue({ queueName: "workers-q", visibilityTimeoutMs: 60_000, workerId: "w2" });
    expect(await sample("dee_active_workers")).toBe(2);
  });

  it("counts retried step attempts and parked tasks and mirrors the janitor's reclaim count", async () => {
    const runId = await insertRun("RUNNING");
    await database.pool.query(
      `insert into step_attempts (run_id, step_id, attempt, error, retry_at)
       values ($1, 's', 1, '{}', now()), ($1, 's', 2, '{}', now()), ($1, 's', 3, '{}', null)`,
      [runId],
    );
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, state, quarantined_at)
       values ($1, $2, 'park-q', 'WORKFLOW_TASK', 'QUARANTINED', now())`,
      [namespaceId, runId],
    );
    const recovery = createRecoveryMetrics();
    recovery.recordReclaimed("w1");
    recovery.recordReclaimed(null);
    expect(await sample("dee_step_retries_total")).toBe(2);
    expect(await sample("dee_tasks_quarantined", { queue: "park-q" })).toBe(1);
    expect(await sample("dee_leases_reclaimed_total", {}, recovery)).toBe(2);
  });

  it("buckets task latency by queue and outcome", async () => {
    const metrics = createEngineMetrics(database.pool, { clock });
    metrics.observeTaskLatency("q", "completed", 0.02);
    metrics.observeTaskLatency("q", "completed", 3);
    metrics.observeTaskLatency("q", "failed", 40);
    const samples = parsePrometheusText(await metrics.render()).samples;
    const find = (name: string, labels: Record<string, string>): number | undefined =>
      samples.find(
        (entry) =>
          entry.name === name &&
          Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
      )?.value;
    expect(find("dee_task_latency_seconds_count", { outcome: "completed" })).toBe(2);
    expect(find("dee_task_latency_seconds_bucket", { outcome: "completed", le: "0.025" })).toBe(1);
    expect(find("dee_task_latency_seconds_bucket", { outcome: "completed", le: "5" })).toBe(2);
    expect(find("dee_task_latency_seconds_bucket", { outcome: "failed", le: "30" })).toBe(0);
    expect(find("dee_task_latency_seconds_bucket", { outcome: "failed", le: "+Inf" })).toBe(1);
  });
});
