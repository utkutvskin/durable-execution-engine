import type { Pool } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.js";
import { appendEventsOnClient, readCurrentSequenceOnClient } from "../event-store/event-store.js";
import { workflowEventSchema } from "../event-store/events.js";
import type { SerializedError } from "../workflow/error-serialization.js";

/**
 * What `AttemptLog.recordFailure` needs. `retryAt` is when the next attempt
 * is due, or `null` when the failure ended the retrying.
 */
export interface RecordAttemptFailureInput {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly error: SerializedError;
  readonly retryAt: Date | null;
}

/**
 * The record of a step's failed attempts, kept in a table and in the run's
 * event log.
 */
export interface AttemptLog {
  /**
   * Stores the failed attempt and appends a `step_attempt_failed` event in
   * one transaction. Returns false and writes nothing when this attempt
   * number was already recorded.
   */
  recordFailure(input: RecordAttemptFailureInput): Promise<boolean>;

  /**
   * The number of the next attempt of the step: one more than the highest
   * attempt recorded so far, or 1.
   */
  nextAttempt(runId: string, stepId: string): Promise<number>;
}

/**
 * Creates an `AttemptLog` over `pool`. Events are encoded with `codec`, the
 * same codec the `EventStore` reading them uses.
 */
export function createAttemptLog(pool: Pool, codec: Codec = jsonCodec): AttemptLog {
  return {
    async recordFailure(input: RecordAttemptFailureInput): Promise<boolean> {
      const event = workflowEventSchema.parse({
        type: "step_attempt_failed",
        stepId: input.stepId,
        attempt: input.attempt,
        error: { name: input.error.name, message: input.error.message },
        retryAt: input.retryAt === null ? null : input.retryAt.toISOString(),
      });
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select 1 from workflow_runs where id = $1 for update", [input.runId]);
        const inserted = await client.query(
          `insert into step_attempts (run_id, step_id, attempt, error, retry_at)
           values ($1, $2, $3, $4::jsonb, $5)
           on conflict (run_id, step_id, attempt) do nothing`,
          [input.runId, input.stepId, input.attempt, JSON.stringify(input.error), input.retryAt],
        );
        if (inserted.rowCount === 0) {
          await client.query("commit");
          return false;
        }
        const currentSeq = await readCurrentSequenceOnClient(client, input.runId);
        await appendEventsOnClient(client, codec, input.runId, currentSeq, [event]);
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async nextAttempt(runId: string, stepId: string): Promise<number> {
      const result = await pool.query<{ last: number | null }>(
        "select max(attempt) as last from step_attempts where run_id = $1 and step_id = $2",
        [runId, stepId],
      );
      return (result.rows[0]?.last ?? 0) + 1;
    },
  };
}
