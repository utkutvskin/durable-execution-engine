import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "./codec.ts";
import { ConcurrencyError } from "./errors.ts";
import { workflowEventSchema, type WorkflowEvent } from "./events.ts";
import { CURRENT_EVENT_VERSION, readVersionedEvent } from "./event-version.ts";
import { rollbackQuietly } from "../db/transaction.ts";

/**
 * A single event as stored in and returned from the event log: the
 * validated event it carries, the sequence number `EventStore.append`
 * assigned it, when it was written and the event format `version` it was
 * written with (`CURRENT_EVENT_VERSION` for every event this build appends).
 */
export interface StoredEvent {
  readonly sequenceNumber: number;
  readonly event: WorkflowEvent;
  readonly createdAt: Date;
  readonly version: number;
}

interface StoredEventRow {
  readonly sequence_number: string;
  readonly payload: string;
  readonly created_at: Date;
  readonly event_version: number;
}

function toStoredEvent(codec: Codec, row: StoredEventRow): StoredEvent {
  return {
    sequenceNumber: Number(row.sequence_number),
    event: readVersionedEvent(codec.decode(row.payload), row.event_version),
    createdAt: row.created_at,
    version: row.event_version,
  };
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
   * for a run with no events past `fromSeq`. With `limit`, at most that many
   * events are returned.
   */
  read(runId: string, fromSeq?: number, limit?: number): Promise<StoredEvent[]>;
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
  if (events.length === 0) {
    return [];
  }
  const result = await client.query<{ sequence_number: string; created_at: Date }>(
    `insert into run_events (run_id, sequence_number, event_type, payload, event_version)
     select $1, batch.sequence_number, batch.event_type, batch.payload::jsonb, $5
     from unnest($2::bigint[], $3::text[], $4::text[])
       as batch (sequence_number, event_type, payload)
     returning sequence_number, created_at`,
    [
      runId,
      events.map((_, offset) => expectedSeq + offset + 1),
      events.map((event) => event.type),
      events.map((event) => codec.encode(event)),
      CURRENT_EVENT_VERSION,
    ],
  );
  const createdAtBySequence = new Map(
    result.rows.map((row) => [Number(row.sequence_number), row.created_at]),
  );
  return events.map((event, offset) => {
    const sequenceNumber = expectedSeq + offset + 1;
    const createdAt = createdAtBySequence.get(sequenceNumber);
    if (createdAt === undefined) {
      throw new Error(`append to run "${runId}" did not return created_at`);
    }
    return { sequenceNumber, event, createdAt, version: CURRENT_EVENT_VERSION };
  });
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
  const result = await client.query<StoredEventRow>(
    `select sequence_number, payload::text as payload, created_at, event_version
     from run_events
     where run_id = $1 and sequence_number > $2
     order by sequence_number asc`,
    [runId, fromSeq],
  );
  return result.rows.map((row) => toStoredEvent(codec, row));
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

      let broken = false;
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
        broken = !(await rollbackQuietly(client));
        if (error instanceof ConcurrencyError) {
          throw error;
        }
        if (isUniqueViolation(error)) {
          throw new ConcurrencyError(runId, expectedSeq);
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },

    async read(runId: string, fromSeq = 0, limit?: number): Promise<StoredEvent[]> {
      const result = await pool.query<StoredEventRow>(
        `select sequence_number, payload::text as payload, created_at, event_version
         from run_events
         where run_id = $1 and sequence_number > $2
         order by sequence_number asc
         limit $3`,
        [runId, fromSeq, limit ?? null],
      );
      return result.rows.map((row) => toStoredEvent(codec, row));
    },
  };
}
