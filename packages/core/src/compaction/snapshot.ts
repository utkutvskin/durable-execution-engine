import type { PoolClient } from "pg";
import { RUN_STATES, type RunState } from "../run/state-machine.js";
import type { RunProjection } from "../run/projection.js";

interface StoredProjection {
  state: string;
  input: unknown;
  result: unknown;
  error: { name: string; message: string } | null;
  closedAt: string | null;
  lastSequenceNumber: number;
}

/**
 * A run's snapshot: the projection folded from every event up to
 * `lastSequenceNumber`, which is what replaces those events once they are
 * pruned. `prunedEventCount` is how many events the pruning removed.
 */
export interface RunSnapshot {
  readonly runId: string;
  readonly lastSequenceNumber: number;
  readonly prunedEventCount: number;
  readonly projection: RunProjection;
}

function toRunState(status: string): RunState {
  const state = RUN_STATES.find((candidate) => candidate === status);
  if (state === undefined) {
    throw new Error(`unknown run status "${status}" in snapshot`);
  }
  return state;
}

/**
 * Serializes a projection for the `run_snapshots.projection` column.
 */
export function serializeProjection(projection: RunProjection): string {
  const stored: StoredProjection = {
    state: projection.state,
    input: projection.input,
    result: projection.result,
    error: projection.error,
    closedAt: projection.closedAt === null ? null : projection.closedAt.toISOString(),
    lastSequenceNumber: projection.lastSequenceNumber,
  };
  return JSON.stringify(stored);
}

/**
 * Reads a projection back from the form `serializeProjection` wrote.
 */
export function deserializeProjection(stored: unknown): RunProjection {
  const value = stored as StoredProjection;
  return {
    state: toRunState(value.state),
    input: value.input,
    result: value.result,
    error: value.error,
    closedAt: value.closedAt === null ? null : new Date(value.closedAt),
    lastSequenceNumber: value.lastSequenceNumber,
  };
}

/**
 * Reads the snapshot of `runId` on `client`, or `undefined` when its history
 * was never pruned.
 */
export async function readSnapshotOnClient(
  client: Pick<PoolClient, "query">,
  runId: string,
): Promise<RunSnapshot | undefined> {
  const result = await client.query<{
    last_sequence_number: string;
    pruned_event_count: string;
    projection: unknown;
  }>(
    `select last_sequence_number, pruned_event_count, projection
     from run_snapshots where run_id = $1`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    runId,
    lastSequenceNumber: Number(row.last_sequence_number),
    prunedEventCount: Number(row.pruned_event_count),
    projection: deserializeProjection(row.projection),
  };
}
