import type { Pool } from "pg";
import { systemClock, type ClockSource } from "../workflow/sources.js";
import { createRecoveryMetrics, type RecoveryMetrics } from "./metrics.js";

/**
 * A task whose lease expired without an ack, nack or heartbeat, and that the
 * janitor made deliverable again. `leasedBy` and `leasedByVersion` identify
 * the worker that held it.
 */
export interface ReclaimedTask {
  readonly taskId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly attempts: number;
  readonly leasedBy: string | null;
  readonly leasedByVersion: string | null;
  readonly quarantined: boolean;
}

/**
 * A task the janitor stopped redelivering because it kept losing its lease.
 */
export interface QuarantinedTask {
  readonly taskId: string;
  readonly namespaceId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly taskType: string;
  readonly reclaimCount: number;
  readonly quarantinedAt: Date;
  readonly reason: string;
}

/**
 * A `RUNNING` run with no open task and no pending timer: nothing is going to
 * move it forward.
 */
export interface StalledRun {
  readonly runId: string;
  readonly namespaceId: string;
  readonly workflowType: string;
}

/**
 * Options for `Janitor.findStalledRuns` and `Janitor.recoverStalledRuns`. A
 * run counts as stalled only after its last event is `graceMs` old, so a
 * run between two tasks is not mistaken for a lost one.
 */
export interface StalledRunOptions {
  readonly graceMs: number;
}

/**
 * Options for `Janitor.recoverStalledRuns`: the queue the replacement
 * `WORKFLOW_TASK` goes to.
 */
export interface RecoverStalledRunsOptions extends StalledRunOptions {
  readonly queueName: string;
}

/**
 * What one `Janitor.sweep` did.
 */
export interface SweepReport {
  readonly reclaimed: readonly ReclaimedTask[];
  readonly stalled: readonly StalledRun[];
  readonly recovered: readonly StalledRun[];
}

/**
 * Repairs the state a crashed worker leaves behind.
 */
export interface Janitor {
  /**
   * Returns every `LEASED` task whose visibility timeout has passed to
   * `PENDING`, clears its lease and counts the reclaim. A worker that is
   * merely slow loses the lease too, which is safe: its late ack is rejected
   * and result recording is idempotent. A task reclaimed `poisonThreshold`
   * times is quarantined instead: it is never delivered again, so a task that
   * keeps killing its worker cannot starve the queue.
   */
  reclaimOrphanedLeases(): Promise<ReclaimedTask[]>;

  /** Lists the quarantined tasks, oldest first, optionally of one namespace. */
  listQuarantined(namespaceId?: string): Promise<QuarantinedTask[]>;

  /**
   * Puts a quarantined task back into the queue with a fresh reclaim budget.
   * Resolves `false` when the task is not quarantined.
   */
  releaseQuarantined(taskId: string): Promise<boolean>;

  /** Lists the stalled runs without changing anything. */
  findStalledRuns(options: StalledRunOptions): Promise<StalledRun[]>;

  /**
   * Enqueues one `WORKFLOW_TASK` for each stalled run so a worker replays it.
   * Concurrent calls cannot enqueue twice for the same run. Resolves with the
   * runs that got a task.
   */
  recoverStalledRuns(options: RecoverStalledRunsOptions): Promise<StalledRun[]>;

  /**
   * One janitor pass: reclaims orphaned leases and, when `stalledRuns` is
   * given, recovers stalled runs. Updates the metrics.
   */
  sweep(stalledRuns?: RecoverStalledRunsOptions): Promise<SweepReport>;

  readonly metrics: RecoveryMetrics;
}

/**
 * Options for `createJanitor`. `clock` supplies "now" for lease expiry and
 * the stalled run grace period, so tests move time without waiting.
 */
export interface JanitorOptions {
  readonly clock?: ClockSource;
  readonly metrics?: RecoveryMetrics;
  readonly poisonThreshold?: number;
}

/**
 * The number of lease losses after which a task is quarantined.
 */
export const DEFAULT_POISON_THRESHOLD = 3;

interface QuarantineRow {
  id: string;
  namespace_id: string;
  run_id: string;
  queue_name: string;
  task_type: string;
  reclaim_count: number;
  quarantined_at: Date;
  quarantine_reason: string;
}

interface ReclaimRow {
  id: string;
  run_id: string;
  queue_name: string;
  attempts: number;
  leased_by: string | null;
  leased_by_version: string | null;
  state: string;
}

interface StalledRow {
  run_id: string;
  namespace_id: string;
  workflow_type: string;
}

const STALLED_RUNS_LOCK_KEY = 7_201_201;

const STALLED_PREDICATE = `
  r.status = 'RUNNING'
  and coalesce((select max(e.created_at) from run_events e where e.run_id = r.id), r.created_at)
      <= $1::timestamptz - $2 * interval '1 millisecond'
  and not exists (
    select 1 from tasks t where t.run_id = r.id and t.state in ('PENDING', 'LEASED', 'QUARANTINED')
  )
  and not exists (
    select 1 from timers m where m.run_id = r.id and m.state = 'PENDING'
  )`;

function toStalledRun(row: StalledRow): StalledRun {
  return { runId: row.run_id, namespaceId: row.namespace_id, workflowType: row.workflow_type };
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

/**
 * Creates a `Janitor` over `pool`.
 */
export function createJanitor(pool: Pool, options: JanitorOptions = {}): Janitor {
  const clock = options.clock ?? systemClock;
  const metrics = options.metrics ?? createRecoveryMetrics();
  const poisonThreshold = options.poisonThreshold ?? DEFAULT_POISON_THRESHOLD;
  if (!Number.isInteger(poisonThreshold) || poisonThreshold <= 0) {
    throw new RangeError(
      `poisonThreshold must be a positive integer, got ${String(poisonThreshold)}`,
    );
  }

  async function reclaimOrphanedLeases(): Promise<ReclaimedTask[]> {
    const now = clock.now();
    const result = await pool.query<ReclaimRow>(
      `with expired as (
         select id, leased_by, leased_by_version from tasks
         where state = 'LEASED' and visible_at <= $1
         for update skip locked
       )
       update tasks
       set state = case when tasks.reclaim_count + 1 >= $2 then 'QUARANTINED' else 'PENDING' end,
           lease_token = null, leased_by = null, leased_by_version = null,
           leased_at = null, reclaim_count = tasks.reclaim_count + 1,
           quarantined_at = case when tasks.reclaim_count + 1 >= $2 then $1::timestamptz end,
           quarantine_reason = case when tasks.reclaim_count + 1 >= $2
             then 'lease lost ' || (tasks.reclaim_count + 1)::text || ' times' end,
           visible_at = $1, updated_at = $1
       from expired
       where tasks.id = expired.id
       returning tasks.id, tasks.run_id, tasks.queue_name, tasks.attempts, tasks.state,
                 expired.leased_by, expired.leased_by_version`,
      [now, poisonThreshold],
    );
    const reclaimed = result.rows.map((row): ReclaimedTask => ({
      taskId: row.id,
      runId: row.run_id,
      queueName: row.queue_name,
      attempts: row.attempts,
      leasedBy: row.leased_by,
      leasedByVersion: row.leased_by_version,
      quarantined: row.state === "QUARANTINED",
    }));
    reclaimed.forEach((task) => {
      metrics.recordReclaimed(task.leasedBy);
    });
    metrics.recordQuarantined(reclaimed.filter((task) => task.quarantined).length);
    return reclaimed;
  }

  async function listQuarantined(namespaceId?: string): Promise<QuarantinedTask[]> {
    const result = await pool.query<QuarantineRow>(
      `select id, namespace_id, run_id, queue_name, task_type, reclaim_count,
              quarantined_at, quarantine_reason
       from tasks
       where state = 'QUARANTINED' and ($1::uuid is null or namespace_id = $1)
       order by quarantined_at, id`,
      [namespaceId ?? null],
    );
    return result.rows.map((row) => ({
      taskId: row.id,
      namespaceId: row.namespace_id,
      runId: row.run_id,
      queueName: row.queue_name,
      taskType: row.task_type,
      reclaimCount: row.reclaim_count,
      quarantinedAt: row.quarantined_at,
      reason: row.quarantine_reason,
    }));
  }

  async function releaseQuarantined(taskId: string): Promise<boolean> {
    const now = clock.now();
    const result = await pool.query(
      `update tasks
       set state = 'PENDING', reclaim_count = 0, quarantined_at = null, quarantine_reason = null,
           visible_at = $2, updated_at = $2
       where id = $1 and state = 'QUARANTINED'`,
      [taskId, now],
    );
    return result.rowCount === 1;
  }

  async function findStalledRuns(stalledOptions: StalledRunOptions): Promise<StalledRun[]> {
    assertNonNegativeInteger("graceMs", stalledOptions.graceMs);
    const result = await pool.query<StalledRow>(
      `select r.id as run_id, r.namespace_id, r.workflow_type
       from workflow_runs r
       where ${STALLED_PREDICATE}
       order by r.created_at, r.id`,
      [clock.now(), stalledOptions.graceMs],
    );
    return result.rows.map(toStalledRun);
  }

  async function recoverStalledRuns(
    recoverOptions: RecoverStalledRunsOptions,
  ): Promise<StalledRun[]> {
    assertNonNegativeInteger("graceMs", recoverOptions.graceMs);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const lock = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_xact_lock($1) as locked",
        [STALLED_RUNS_LOCK_KEY],
      );
      if (lock.rows[0]?.locked !== true) {
        await client.query("rollback");
        return [];
      }
      const now = clock.now();
      const result = await client.query<StalledRow>(
        `with stalled as (
           select r.id, r.namespace_id, r.workflow_type
           from workflow_runs r
           where ${STALLED_PREDICATE}
         ),
         enqueued as (
           insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
           select namespace_id, id, $3, 'WORKFLOW_TASK', '{"reason":"stalled_run_recovery"}'::jsonb, $1
           from stalled
           returning run_id
         )
         select stalled.id as run_id, stalled.namespace_id, stalled.workflow_type
         from stalled join enqueued on enqueued.run_id = stalled.id
         order by stalled.id`,
        [now, recoverOptions.graceMs, recoverOptions.queueName],
      );
      await client.query("commit");
      return result.rows.map(toStalledRun);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    metrics,
    reclaimOrphanedLeases,
    listQuarantined,
    releaseQuarantined,
    findStalledRuns,
    recoverStalledRuns,

    async sweep(stalledRuns?: RecoverStalledRunsOptions): Promise<SweepReport> {
      const reclaimed = await reclaimOrphanedLeases();
      let stalled: StalledRun[] = [];
      let recovered: StalledRun[] = [];
      if (stalledRuns !== undefined) {
        stalled = await findStalledRuns(stalledRuns);
        recovered = await recoverStalledRuns(stalledRuns);
        metrics.recordStalledDetected(stalled.length);
        metrics.recordStalledRecovered(recovered.length);
      }
      metrics.recordSweep(clock.now());
      return { reclaimed, stalled, recovered };
    },
  };
}
