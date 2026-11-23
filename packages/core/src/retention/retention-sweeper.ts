import type { Pool } from "pg";
import { systemClock, type ClockSource } from "../workflow/sources.ts";
import { retireFinishedTasks } from "./task-retirement.ts";

/**
 * How long a completed task stays in `tasks` before it moves to
 * `task_history`. The dequeue reads recent completions for its namespace
 * turns, so they stay a little while.
 */
export const DEFAULT_FINISHED_TASK_GRACE_MS = 30_000;

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 10;

/**
 * The rows one purge deleted, per table. `taskHistory` counts retired tasks
 * and the completed tasks of purged runs that were not retired yet.
 */
export interface PurgedRows {
  readonly workflowTaskResults: number;
  readonly stepAttempts: number;
  readonly timers: number;
  readonly scheduleTriggers: number;
  readonly deadLetters: number;
  readonly taskHistory: number;
  readonly concurrencySlotHistory: number;
}

/**
 * What a purge did in one namespace, with the retention it applied.
 */
export interface NamespacePurge {
  readonly namespaceId: string;
  readonly closedRunRetentionMs: number;
  readonly runsPurged: number;
  readonly rows: PurgedRows;
}

/**
 * What `RetentionSweeper.purgeClosedRuns` did: the totals and the namespaces
 * it purged runs in.
 */
export interface PurgeReport {
  readonly runsPurged: number;
  readonly rows: PurgedRows;
  readonly namespaces: readonly NamespacePurge[];
}

/**
 * What one `RetentionSweeper.sweep` did.
 */
export interface RetentionReport extends PurgeReport {
  readonly tasksRetired: number;
}

/**
 * Options for `createRetentionSweeper`.
 *
 * - `finishedTaskGraceMs`: the age of a completed task before it moves to
 *   `task_history` (default `DEFAULT_FINISHED_TASK_GRACE_MS`).
 * - `closedRunRetentionMs`: how long a closed run keeps its execution data in
 *   a namespace without its own setting (see `setNamespaceRetention`). When
 *   it is left out, only namespaces with their own setting are purged.
 * - `batchSize`: the rows (tasks) or runs one statement handles (default
 *   1000), and `maxBatches` the statements one call issues per table and
 *   namespace (default 10), so one sweep has bounded work.
 */
export interface RetentionSweeperOptions {
  readonly clock?: ClockSource;
  readonly finishedTaskGraceMs?: number;
  readonly closedRunRetentionMs?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

/**
 * Keeps the engine's tables from growing without bound. It never touches an
 * open run.
 */
export interface RetentionSweeper {
  /**
   * Moves completed tasks older than the grace period from `tasks` to
   * `task_history` and returns how many moved.
   */
  retireFinishedTasks(): Promise<number>;

  /**
   * In every namespace with a retention, purges the runs that closed at
   * least that long ago: their `workflow_task_results`, `step_attempts`,
   * timers, `schedule_triggers`, requeued dead letters, task history and
   * released concurrency slot history are deleted, and the run is marked
   * with `purged_at` so it is not visited again. `SKIPPED` schedule
   * triggers older than the retention go too. The run row, its events (see
   * `createHistoryCompactor`), its step results and its open dead letters
   * stay.
   */
  purgeClosedRuns(): Promise<PurgeReport>;

  /** Runs `retireFinishedTasks`, then `purgeClosedRuns`. */
  sweep(): Promise<RetentionReport>;
}

const EMPTY_ROWS: PurgedRows = {
  workflowTaskResults: 0,
  stepAttempts: 0,
  timers: 0,
  scheduleTriggers: 0,
  deadLetters: 0,
  taskHistory: 0,
  concurrencySlotHistory: 0,
};

interface PurgeRow {
  readonly runs: number;
  readonly workflow_task_results: number;
  readonly step_attempts: number;
  readonly timers: number;
  readonly schedule_triggers: number;
  readonly dead_letters: number;
  readonly task_history: number;
  readonly concurrency_slot_history: number;
}

function addRows(total: PurgedRows, row: PurgeRow): PurgedRows {
  return {
    workflowTaskResults: total.workflowTaskResults + row.workflow_task_results,
    stepAttempts: total.stepAttempts + row.step_attempts,
    timers: total.timers + row.timers,
    scheduleTriggers: total.scheduleTriggers + row.schedule_triggers,
    deadLetters: total.deadLetters + row.dead_letters,
    taskHistory: total.taskHistory + row.task_history,
    concurrencySlotHistory: total.concurrencySlotHistory + row.concurrency_slot_history,
  };
}

function sumRows(left: PurgedRows, right: PurgedRows): PurgedRows {
  return {
    workflowTaskResults: left.workflowTaskResults + right.workflowTaskResults,
    stepAttempts: left.stepAttempts + right.stepAttempts,
    timers: left.timers + right.timers,
    scheduleTriggers: left.scheduleTriggers + right.scheduleTriggers,
    deadLetters: left.deadLetters + right.deadLetters,
    taskHistory: left.taskHistory + right.taskHistory,
    concurrencySlotHistory: left.concurrencySlotHistory + right.concurrencySlotHistory,
  };
}

function assertRetentionMs(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/**
 * Creates a `RetentionSweeper` over `pool`. Several sweepers may run at once
 * (one per queue leader): each run and each task is handled by one of them.
 */
export function createRetentionSweeper(
  pool: Pool,
  options: RetentionSweeperOptions = {},
): RetentionSweeper {
  const clock = options.clock ?? systemClock;
  const graceMs = options.finishedTaskGraceMs ?? DEFAULT_FINISHED_TASK_GRACE_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  assertRetentionMs("finishedTaskGraceMs", graceMs);
  assertPositiveInteger("batchSize", batchSize);
  assertPositiveInteger("maxBatches", maxBatches);
  if (options.closedRunRetentionMs !== undefined) {
    assertRetentionMs("closedRunRetentionMs", options.closedRunRetentionMs);
  }

  async function retire(): Promise<number> {
    const before = new Date(clock.now().getTime() - graceMs);
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const moved = await retireFinishedTasks(pool, { before, limit: batchSize });
      total += moved;
      if (moved < batchSize) {
        break;
      }
    }
    return total;
  }

  async function purgeNamespace(
    namespaceId: string,
    closedRunRetentionMs: number,
  ): Promise<NamespacePurge> {
    const now = clock.now();
    const cutoff = new Date(now.getTime() - closedRunRetentionMs);
    let runsPurged = 0;
    let rows = EMPTY_ROWS;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await pool.query<PurgeRow>("select * from purge_closed_runs($1, $2, $3, $4)", [
        namespaceId,
        cutoff,
        batchSize,
        now,
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        break;
      }
      runsPurged += row.runs;
      rows = addRows(rows, row);
      if (row.runs < batchSize) {
        break;
      }
    }
    return { namespaceId, closedRunRetentionMs, runsPurged, rows };
  }

  async function purge(): Promise<PurgeReport> {
    const retained = await pool.query<{ id: string; retention_ms: string | null }>(
      `select n.id,
              case when r.namespace_id is null then $1::bigint
                   else r.closed_run_retention_ms end as retention_ms
       from namespaces n left join namespace_retention r on r.namespace_id = n.id
       order by n.id`,
      [options.closedRunRetentionMs ?? null],
    );
    const namespaces: NamespacePurge[] = [];
    let runsPurged = 0;
    let rows = EMPTY_ROWS;
    for (const namespace of retained.rows) {
      if (namespace.retention_ms === null) {
        continue;
      }
      const purged = await purgeNamespace(namespace.id, Number(namespace.retention_ms));
      runsPurged += purged.runsPurged;
      rows = sumRows(rows, purged.rows);
      if (purged.runsPurged > 0) {
        namespaces.push(purged);
      }
    }
    return { runsPurged, rows, namespaces };
  }

  return {
    retireFinishedTasks: retire,
    purgeClosedRuns: purge,
    async sweep(): Promise<RetentionReport> {
      const tasksRetired = await retire();
      const purged = await purge();
      return { tasksRetired, ...purged };
    },
  };
}

/**
 * Sets how long the closed runs of `namespaceId` keep their execution data,
 * overriding the sweeper's `closedRunRetentionMs`. `null` keeps them forever.
 */
export async function setNamespaceRetention(
  pool: Pool,
  namespaceId: string,
  closedRunRetentionMs: number | null,
): Promise<void> {
  if (closedRunRetentionMs !== null) {
    assertRetentionMs("closedRunRetentionMs", closedRunRetentionMs);
  }
  await pool.query(
    `insert into namespace_retention (namespace_id, closed_run_retention_ms)
     values ($1, $2)
     on conflict (namespace_id) do update
       set closed_run_retention_ms = excluded.closed_run_retention_ms, updated_at = now()`,
    [namespaceId, closedRunRetentionMs],
  );
}

/**
 * Removes the retention of `namespaceId`, so the sweeper's default applies
 * again. Returns whether the namespace had one.
 */
export async function clearNamespaceRetention(pool: Pool, namespaceId: string): Promise<boolean> {
  const result = await pool.query("delete from namespace_retention where namespace_id = $1", [
    namespaceId,
  ]);
  return result.rowCount === 1;
}
