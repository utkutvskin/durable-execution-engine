import type { Pool } from "pg";
import { systemClock, type ClockSource } from "../workflow/sources.js";

/**
 * A live sticky claim: `workerId` is preferred for the run's workflow tasks
 * until `expiresAt`.
 */
export interface StickyClaim {
  readonly runId: string;
  readonly workerId: string;
  readonly expiresAt: Date;
}

/**
 * Records which worker holds a run in its replay cache. While a claim is
 * live, `TaskQueue.dequeue` called with `stickyFor` hands that run's tasks
 * only to the claiming worker; once the claim expires (the sticky timeout)
 * any worker may take them and replay from scratch.
 */
export interface StickyRouter {
  claim(runId: string, workerId: string, stickyTimeoutMs: number): Promise<StickyClaim>;
  find(runId: string): Promise<StickyClaim | undefined>;
  release(runId: string, workerId: string): Promise<boolean>;
  releaseWorker(workerId: string): Promise<number>;
}

interface ClaimRow {
  run_id: string;
  worker_id: string;
  expires_at: Date;
}

function toClaim(row: ClaimRow): StickyClaim {
  return { runId: row.run_id, workerId: row.worker_id, expiresAt: row.expires_at };
}

/**
 * Creates a `StickyRouter` over `pool`. `claim` takes over a claim that has
 * expired or belongs to the same worker and refreshes its expiry, and leaves a
 * live claim of another worker alone, returning that one instead. `find`
 * resolves `undefined` for a missing or expired claim.
 */
export function createStickyRouter(
  pool: Pool,
  options: { readonly clock?: ClockSource } = {},
): StickyRouter {
  const clock = options.clock ?? systemClock;

  return {
    async claim(runId: string, workerId: string, stickyTimeoutMs: number): Promise<StickyClaim> {
      if (!Number.isInteger(stickyTimeoutMs) || stickyTimeoutMs < 1) {
        throw new RangeError(
          `stickyTimeoutMs must be a positive integer, got ${String(stickyTimeoutMs)}`,
        );
      }
      const now = clock.now();
      const result = await pool.query<ClaimRow>(
        `insert into run_stickiness (run_id, worker_id, expires_at, updated_at)
         values ($1, $2, $3::timestamptz + $4 * interval '1 millisecond', $3)
         on conflict (run_id) do update
           set worker_id = case
                 when run_stickiness.worker_id = excluded.worker_id
                   or run_stickiness.expires_at <= $3 then excluded.worker_id
                 else run_stickiness.worker_id end,
               expires_at = case
                 when run_stickiness.worker_id = excluded.worker_id
                   or run_stickiness.expires_at <= $3 then excluded.expires_at
                 else run_stickiness.expires_at end,
               updated_at = $3
         returning run_id, worker_id, expires_at`,
        [runId, workerId, now, stickyTimeoutMs],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("sticky claim returned no row");
      }
      return toClaim(row);
    },

    async find(runId: string): Promise<StickyClaim | undefined> {
      const result = await pool.query<ClaimRow>(
        `select run_id, worker_id, expires_at from run_stickiness
         where run_id = $1 and expires_at > $2`,
        [runId, clock.now()],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toClaim(row);
    },

    async release(runId: string, workerId: string): Promise<boolean> {
      const result = await pool.query(
        "delete from run_stickiness where run_id = $1 and worker_id = $2",
        [runId, workerId],
      );
      return result.rowCount === 1;
    },

    async releaseWorker(workerId: string): Promise<number> {
      const result = await pool.query("delete from run_stickiness where worker_id = $1", [
        workerId,
      ]);
      return result.rowCount ?? 0;
    },
  };
}
