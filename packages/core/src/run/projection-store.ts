import type { Pool, PoolClient } from "pg";
import type { Codec } from "../event-store/codec.js";
import { readEventsOnClient, type EventStore } from "../event-store/event-store.js";
import { RUN_STATES, type RunState } from "./state-machine.js";
import { createInitialProjection, foldRunEvents, type RunProjection } from "./projection.js";

interface RunRow {
  status: string;
  input: unknown;
  result: unknown;
  error: { name: string; message: string } | null;
  closed_at: Date | null;
  last_sequence_number: string;
}

function toRunState(status: string): RunState {
  const state = RUN_STATES.find((candidate) => candidate === status);
  if (state === undefined) {
    throw new Error(`unknown run status "${status}"`);
  }
  return state;
}

function projectionFromRow(row: RunRow): RunProjection {
  return {
    state: toRunState(row.status),
    input: row.input,
    result: row.result,
    error: row.error,
    closedAt: row.closed_at,
    lastSequenceNumber: Number(row.last_sequence_number),
  };
}

async function lockRunRow(client: PoolClient, runId: string): Promise<RunRow> {
  const result = await client.query<RunRow>(
    `select status, input, result, error, closed_at, last_sequence_number
     from workflow_runs where id = $1 for update`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`workflow run "${runId}" does not exist`);
  }
  return row;
}

async function writeProjection(
  client: PoolClient,
  runId: string,
  projection: RunProjection,
): Promise<void> {
  await client.query(
    `update workflow_runs
     set status = $2, input = $3::jsonb, result = $4::jsonb, error = $5::jsonb,
         closed_at = $6, last_sequence_number = $7, updated_at = now()
     where id = $1`,
    [
      runId,
      projection.state,
      JSON.stringify(projection.input),
      JSON.stringify(projection.result),
      projection.error === null ? null : JSON.stringify(projection.error),
      projection.closedAt,
      projection.lastSequenceNumber,
    ],
  );
}

async function foldInto(
  pool: Pool,
  store: EventStore,
  runId: string,
  startFrom: (row: RunRow) => RunProjection,
): Promise<RunProjection> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const row = await lockRunRow(client, runId);
    const start = startFrom(row);
    const events = await store.read(runId, start.lastSequenceNumber);
    const next = foldRunEvents(events, start);
    await writeProjection(client, runId, next);
    await client.query("commit");
    return next;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Brings `runId`'s `workflow_runs` row up to date by folding only the
 * events after its `last_sequence_number` onto its stored state. An event
 * that is invalid for the run's current state, such as anything after a
 * terminal event, rejects with `InvalidTransitionError` and leaves the row
 * untouched.
 */
export function refreshProjection(
  pool: Pool,
  store: EventStore,
  runId: string,
): Promise<RunProjection> {
  return foldInto(pool, store, runId, projectionFromRow);
}

/**
 * Discards everything the projection derived for `runId` and rebuilds it
 * from the run's whole event log. The result is identical to what
 * incremental `refreshProjection` calls produced.
 */
export function rebuildProjection(
  pool: Pool,
  store: EventStore,
  runId: string,
): Promise<RunProjection> {
  return foldInto(pool, store, runId, createInitialProjection);
}

/**
 * Like `refreshProjection`, but on an existing client inside the caller's
 * transaction, so the projection also folds events the caller appended and
 * has not committed. The caller must already hold the run row lock.
 */
export async function refreshProjectionOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
): Promise<RunProjection> {
  const row = await lockRunRow(client, runId);
  const start = projectionFromRow(row);
  const events = await readEventsOnClient(client, codec, runId, start.lastSequenceNumber);
  const next = foldRunEvents(events, start);
  await writeProjection(client, runId, next);
  return next;
}
