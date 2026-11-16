import type { Pool } from "pg";

/**
 * The last heartbeat a step reported: the attempt that sent it, the details
 * it carried and when it was stored.
 */
export interface StepHeartbeat {
  readonly attempt: number;
  readonly details: unknown;
  readonly recordedAt: Date;
}

/**
 * What `HeartbeatStore.record` stores for one step.
 */
export interface RecordHeartbeatInput {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly details: unknown;
  readonly recordedAt: Date;
}

/**
 * Keeps the last heartbeat of every step, so a retried attempt can resume
 * from the details its previous attempt reported.
 */
export interface HeartbeatStore {
  /**
   * Stores the heartbeat as the step's last one. A heartbeat of an older
   * attempt than the stored one is ignored, so a late write of an attempt
   * that already lost its turn cannot overwrite the next attempt's
   * progress. Details are stored as JSON; `undefined` is stored as `null`.
   */
  record(input: RecordHeartbeatInput): Promise<void>;

  /**
   * The last heartbeat of the step, or `undefined` when it never reported
   * one.
   */
  read(runId: string, stepId: string): Promise<StepHeartbeat | undefined>;
}

interface HeartbeatRow {
  readonly attempt: number;
  readonly details: unknown;
  readonly recorded_at: Date;
}

/**
 * Creates a `HeartbeatStore` over the `step_heartbeats` table of `pool`.
 */
export function createHeartbeatStore(pool: Pool): HeartbeatStore {
  return {
    async record(input: RecordHeartbeatInput): Promise<void> {
      await pool.query(
        `insert into step_heartbeats (run_id, step_id, attempt, details, recorded_at)
         values ($1, $2, $3, $4::jsonb, $5)
         on conflict (run_id, step_id) do update
           set attempt = excluded.attempt,
               details = excluded.details,
               recorded_at = excluded.recorded_at
           where step_heartbeats.attempt <= excluded.attempt`,
        [
          input.runId,
          input.stepId,
          input.attempt,
          JSON.stringify(input.details ?? null),
          input.recordedAt,
        ],
      );
    },

    async read(runId: string, stepId: string): Promise<StepHeartbeat | undefined> {
      const result = await pool.query<HeartbeatRow>(
        "select attempt, details, recorded_at from step_heartbeats where run_id = $1 and step_id = $2",
        [runId, stepId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : { attempt: row.attempt, details: row.details, recordedAt: row.recorded_at };
    },
  };
}
