import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "./codec.js";
import { ConcurrencyError } from "./errors.js";
import { workflowEventSchema, type WorkflowEvent } from "./events.js";

/**
 * A single event as stored in and returned from the event log: the
 * validated event it carries, the sequence number `EventStore.append`
 * assigned it, and when it was written.
 */
export interface StoredEvent {
  readonly sequenceNumber: number;
  readonly event: WorkflowEvent;
  readonly createdAt: Date;
}

/**
 * The append-only log of a run's history: the single source of truth every
 * other projection (state machine, task queue, timers) is derived from.
 * `run_events` rows are only ever inserted, never updated or deleted, by
 * any code path that goes through this interface.
 */
export interface EventStore {
  /**
   * Appends `events` to `runId`'s history, assigning them consecutive
   * sequence numbers starting at `expectedSeq + 1`. `expectedSeq` must be
   * the sequence number of the last event the caller has already seen (0
   * for a run with no history yet). If the run's actual current sequence
   * number is not `expectedSeq` — because a concurrent append won a race,
   * or because the caller's history was stale — the whole append is
   * rejected with a `ConcurrencyError` and nothing is written. An empty
   * `events` array is a no-op that returns an empty array without
   * touching the database.
   */
  append(
    runId: string,
    expectedSeq: number,
    events: readonly WorkflowEvent[],
  ): Promise<StoredEvent[]>;

  /**
   * Reads `runId`'s history in ascending sequence order, starting after
   * `fromSeq` (default 0, i.e. the whole history). Returns an empty array
   * for a run with no events past `fromSeq`.
   */
  read(runId: string, fromSeq?: number): Promise<StoredEvent[]>;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function readCurrentSequence(client: PoolClient, runId: string): Promise<number> {
  const result = await client.query<{ seq: string }>(
    `select greatest(
       coalesce((select max(sequence_number) from run_events where run_id = $1), 0),
       coalesce((select last_sequence_number from run_snapshots where run_id = $1), 0)
     ) as seq`,
    [runId],
  );
  return Number(result.rows[0]?.seq ?? "0");
}

/**
 * Appends already validated `events` to `runId` on `client`, inside a
 * transaction the caller owns. Same sequence rules as `EventStore.append`,
 * but it never begins, commits or rolls back, so a caller can make the
 * append atomic with writes of its own.
 */
export async function appendEventsOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
  expectedSeq: number,
  events: readonly WorkflowEvent[],
): Promise<StoredEvent[]> {
  const currentSeq = await readCurrentSequence(client, runId);
  if (currentSeq !== expectedSeq) {
    throw new ConcurrencyError(runId, expectedSeq, currentSeq);
  }
  const stored: StoredEvent[] = [];
  for (const [offset, event] of events.entries()) {
    const sequenceNumber = expectedSeq + offset + 1;
    const result = await client.query<{ created_at: Date }>(
      `insert into run_events (run_id, sequence_number, event_type, payload)
       values ($1, $2, $3, $4)
       returning created_at`,
      [runId, sequenceNumber, event.type, codec.encode(event)],
    );
    const createdAt = result.rows[0]?.created_at;
    if (createdAt === undefined) {
      throw new Error(`append to run "${runId}" did not return created_at`);
    }
    stored.push({ sequenceNumber, event, createdAt });
  }
  return stored;
}

/**
 * Reads the sequence number of `runId`'s last event on `client` (0 when the
 * run has no history).
 */
export async function readCurrentSequenceOnClient(
  client: PoolClient,
  runId: string,
): Promise<number> {
  return readCurrentSequence(client, runId);
}

/**
 * Reads `runId`'s events after `fromSeq`, in order, on an existing client so
 * the read joins the caller's transaction and sees its uncommitted appends.
 */
export async function readEventsOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
  fromSeq = 0,
): Promise<StoredEvent[]> {
  const result = await client.query<{
    sequence_number: string;
    payload: string;
    created_at: Date;
  }>(
    `select sequence_number, payload::text as payload, created_at
     from run_events
     where run_id = $1 and sequence_number > $2
     order by sequence_number asc`,
    [runId, fromSeq],
  );
  return result.rows.map((row) => ({
    sequenceNumber: Number(row.sequence_number),
    event: workflowEventSchema.parse(codec.decode(row.payload)),
    createdAt: row.created_at,
  }));
}

/**
 * Creates an `EventStore` backed by the `run_events` table reachable
 * through `pool`. Optimistic concurrency is enforced by checking the
 * current sequence number inside the same transaction as the insert, with
 * the table's `(run_id, sequence_number)` unique constraint as the final
 * guard against a race that check alone cannot see.
 */
export function createPostgresEventStore(pool: Pool, codec: Codec = jsonCodec): EventStore {
  return {
    async append(
      runId: string,
      expectedSeq: number,
      events: readonly WorkflowEvent[],
    ): Promise<StoredEvent[]> {
      if (events.length === 0) {
        return [];
      }
      const validatedEvents = events.map((event) => workflowEventSchema.parse(event));

      const client = await pool.connect();
      try {
        await client.query("begin");
        const stored = await appendEventsOnClient(
          client,
          codec,
          runId,
          expectedSeq,
          validatedEvents,
        );
        await client.query("commit");
        return stored;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if (error instanceof ConcurrencyError) {
          throw error;
        }
        if (isUniqueViolation(error)) {
          throw new ConcurrencyError(runId, expectedSeq);
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async read(runId: string, fromSeq = 0): Promise<StoredEvent[]> {
      const result = await pool.query<{
        sequence_number: string;
        payload: string;
        created_at: Date;
      }>(
        `select sequence_number, payload::text as payload, created_at
         from run_events
         where run_id = $1 and sequence_number > $2
         order by sequence_number asc`,
        [runId, fromSeq],
      );
      return result.rows.map((row) => ({
        sequenceNumber: Number(row.sequence_number),
        event: workflowEventSchema.parse(codec.decode(row.payload)),
        createdAt: row.created_at,
      }));
    },
  };
}
