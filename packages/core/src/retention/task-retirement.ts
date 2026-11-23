import type { Pool } from "pg";

/**
 * Options for `retireFinishedTasks`. Only tasks that completed at or before
 * `before` move, at most `limit` of them.
 */
export interface RetireFinishedTasksOptions {
  readonly before: Date;
  readonly limit: number;
}

/**
 * Moves up to `limit` `COMPLETED` tasks that settled at or before `before`
 * from `tasks` to the append-only `task_history` table, oldest first, in one
 * statement, and returns how many moved. A task that still holds a
 * concurrency slot stays, and a task another call is moving at the same time
 * is skipped, so concurrent calls never move a task twice. `all_tasks` reads
 * both tables as one.
 */
export async function retireFinishedTasks(
  pool: Pool,
  options: RetireFinishedTasksOptions,
): Promise<number> {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new RangeError(`limit must be a positive integer, got ${String(options.limit)}`);
  }
  const result = await pool.query<{ moved: number }>(
    "select retire_finished_tasks($1, $2) as moved",
    [options.before, options.limit],
  );
  return result.rows[0]?.moved ?? 0;
}
