import type { Pool } from "pg";
import type { RunState } from "../run/state-machine.js";

/**
 * One run of a chain: the runs a workflow went through by continuing as new,
 * ordered by `chainIndex` from 0 for the first run.
 */
export interface ChainRun {
  readonly runId: string;
  readonly chainIndex: number;
  readonly status: RunState;
  readonly input: unknown;
  readonly result: unknown;
  readonly continuedFromRunId: string | null;
  readonly startedAt: Date;
  readonly closedAt: Date | null;
}

interface ChainRow {
  id: string;
  chain_index: number;
  status: RunState;
  input: unknown;
  result: unknown;
  continued_from_run_id: string | null;
  started_at: Date;
  closed_at: Date | null;
}

/**
 * Reads every run that shares `firstRunId`, in chain order. A run that never
 * continued is a chain of one. Returns an empty array for an unknown id.
 */
export async function readRunChain(pool: Pool, firstRunId: string): Promise<ChainRun[]> {
  const result = await pool.query<ChainRow>(
    `select id, chain_index, status, input, result, continued_from_run_id, started_at, closed_at
     from workflow_runs where first_run_id = $1 order by chain_index asc`,
    [firstRunId],
  );
  return result.rows.map((row) => ({
    runId: row.id,
    chainIndex: row.chain_index,
    status: row.status,
    input: row.input,
    result: row.result,
    continuedFromRunId: row.continued_from_run_id,
    startedAt: row.started_at,
    closedAt: row.closed_at,
  }));
}

/**
 * Finds the run of the chain that is still current: the one with the highest
 * `chainIndex`. Returns `undefined` for an unknown `firstRunId`. Clients that
 * hold only the first run id use this to address signals, queries and
 * cancellations at the run that is actually open.
 */
export async function findCurrentRun(
  pool: Pool,
  firstRunId: string,
): Promise<ChainRun | undefined> {
  const chain = await readRunChain(pool, firstRunId);
  return chain[chain.length - 1];
}
