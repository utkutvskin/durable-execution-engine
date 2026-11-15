import type { PoolClient } from "pg";
import type { SearchAttributeUpsert } from "./search-attributes.ts";

/**
 * Applies a recorded search attribute upsert to the row of `runId` inside
 * the caller's transaction: values replace, `null` removes. The caller must
 * hold the run row lock.
 */
export async function applySearchAttributeUpsertOnClient(
  client: PoolClient,
  runId: string,
  upsert: SearchAttributeUpsert,
): Promise<void> {
  const set: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(upsert)) {
    if (value === null) {
      removed.push(name);
    } else {
      set[name] = value;
    }
  }
  await client.query(
    `update workflow_runs
     set search_attributes = (search_attributes || $2::jsonb) - $3::text[], updated_at = now()
     where id = $1`,
    [runId, JSON.stringify(set), removed],
  );
}
