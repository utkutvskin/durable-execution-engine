import type { PoolClient } from "pg";

/**
 * The row of a locked run: its namespace, status and parent.
 */
export interface LockedRun {
  readonly namespaceId: string;
  readonly status: string;
  readonly parentRunId: string | null;
}

interface LockedRunRow {
  namespace_id: string;
  status: string;
  parent_run_id: string | null;
}

/**
 * Locks `runId`'s row for the rest of the transaction, taking its parent's
 * row lock first when it has one. Every path that closes a run or cascades
 * to children locks in this order, ancestors before descendants, so a child
 * closing while its parent closes cannot deadlock. Returns `undefined` when
 * the run does not exist.
 */
export async function lockRunWithParent(
  client: PoolClient,
  runId: string,
): Promise<LockedRun | undefined> {
  const parent = await client.query<{ parent_run_id: string | null }>(
    "select parent_run_id from workflow_runs where id = $1",
    [runId],
  );
  const parentRunId = parent.rows[0]?.parent_run_id;
  if (parentRunId !== undefined && parentRunId !== null) {
    await client.query("select 1 from workflow_runs where id = $1 for update", [parentRunId]);
  }
  const run = await client.query<LockedRunRow>(
    "select namespace_id, status, parent_run_id from workflow_runs where id = $1 for update",
    [runId],
  );
  const row = run.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return { namespaceId: row.namespace_id, status: row.status, parentRunId: row.parent_run_id };
}
