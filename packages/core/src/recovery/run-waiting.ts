import type { Pool } from "pg";

/**
 * What a suspended run waits for: `external` is a signal or a child run, and
 * `dead_letter` is a step that was dead-lettered and needs an operator.
 */
export type WaitingOn = "external" | "dead_letter";

/**
 * What a decision tells the janitor about a run. `waitingOn` is `null` when the
 * run is not waiting for anything outside the engine. `progressed` resets the
 * recovery backoff of the run.
 */
export interface RunWaitingMark {
  readonly runId: string;
  readonly waitingOn: WaitingOn | null;
  readonly progressed: boolean;
}

/**
 * Stores the waiting marker of a run. A run that is marked waiting is not
 * stalled, so the janitor leaves it alone; whoever ends the wait (a signal, a
 * finished child, a requeued dead letter) enqueues a workflow task, and the
 * next decision marks the run again.
 */
export async function markRunWaiting(pool: Pool, mark: RunWaitingMark): Promise<void> {
  await pool.query(
    `update workflow_runs
     set waiting_on = $2,
         recovery_count = case when $3::boolean then 0 else recovery_count end
     where id = $1`,
    [mark.runId, mark.waitingOn, mark.progressed],
  );
}
