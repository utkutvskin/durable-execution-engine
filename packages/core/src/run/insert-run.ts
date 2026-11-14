import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.ts";
import { appendEventsOnClient } from "../event-store/event-store.ts";
import { applyRunTimeoutsOnClient } from "../timeouts/run-timeouts.ts";

/**
 * What `insertRunOnClient` writes: a run of `workflowType` in the namespace
 * `namespaceId` whose first workflow task goes to `queueName`.
 */
export interface InsertRunInput {
  readonly namespaceId: string;
  readonly workflowType: string;
  readonly input: unknown;
  readonly queueName: string;
  readonly idempotencyKey?: string | undefined;
  readonly runTimeoutMs?: number | undefined;
  readonly executionTimeoutMs?: number | undefined;
  readonly taskReason?: string | undefined;
}

/**
 * Writes a new run on `client` inside the caller's transaction: the run row,
 * its timeout timers, its `run_started` event and its first workflow task.
 * Returns the new run id, or `undefined` when `idempotencyKey` already holds
 * a run in the namespace (nothing is written then).
 */
export async function insertRunOnClient(
  client: PoolClient,
  codec: Codec,
  input: InsertRunInput,
): Promise<string | undefined> {
  const inserted = await client.query<{ id: string; started_at: Date }>(
    `insert into workflow_runs
       (namespace_id, workflow_type, input, idempotency_key, queue_name)
     values ($1, $2, $3::jsonb, $4, $5)
     on conflict (namespace_id, idempotency_key) where idempotency_key is not null
     do nothing
     returning id, started_at`,
    [
      input.namespaceId,
      input.workflowType,
      JSON.stringify(input.input ?? null),
      input.idempotencyKey ?? null,
      input.queueName,
    ],
  );
  const created = inserted.rows[0];
  if (created === undefined) {
    return undefined;
  }
  await applyRunTimeoutsOnClient(client, created.id, created.started_at, {
    runTimeoutMs: input.runTimeoutMs,
    executionTimeoutMs: input.executionTimeoutMs,
  });
  await appendEventsOnClient(client, codec, created.id, 0, [
    { type: "run_started", workflowType: input.workflowType, input: input.input ?? null },
  ]);
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [
      input.namespaceId,
      created.id,
      input.queueName,
      JSON.stringify({ reason: input.taskReason ?? "start" }),
    ],
  );
  return created.id;
}
