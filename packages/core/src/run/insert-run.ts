import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.ts";
import { appendEventsOnClient } from "../event-store/event-store.ts";
import { applyRunTimeoutsOnClient } from "../timeouts/run-timeouts.ts";
import { validatePriority } from "./priority.ts";
import {
  validateMemo,
  validateSearchAttributes,
  type SearchAttributes,
} from "../visibility/search-attributes.ts";

/**
 * What `insertRunOnClient` writes: a run of `workflowType` in the namespace
 * `namespaceId` whose first workflow task goes to `queueName`. `priority`
 * (default 0) orders every task of the run; see `validatePriority`.
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
  readonly searchAttributes?: SearchAttributes | undefined;
  readonly memo?: unknown;
  readonly priority?: number | undefined;
  /** The id the run gets; a fresh one is generated without it. */
  readonly runId?: string | undefined;
  /** Marks the run as the open run of a singleton key (see `SingletonStart`). */
  readonly singletonKey?: string | undefined;
  /** When `idempotencyKey` stops mapping to the run. */
  readonly idempotencyExpiresAt?: Date | undefined;
}

/**
 * Writes a new run on `client` inside the caller's transaction: the run row
 * with its search attributes and memo,
 * its timeout timers, its `run_started` event and its first workflow task.
 * Returns the new run id, or `undefined` when `idempotencyKey` already holds
 * a run in the namespace (nothing is written then). Rejects with
 * `InvalidSearchAttributesError` before writing anything.
 */
export async function insertRunOnClient(
  client: PoolClient,
  codec: Codec,
  input: InsertRunInput,
): Promise<string | undefined> {
  const searchAttributes =
    input.searchAttributes === undefined ? {} : validateSearchAttributes(input.searchAttributes);
  const memo = input.memo === undefined ? undefined : validateMemo(input.memo);
  const priority = validatePriority(input.priority);
  const inserted = await client.query<{ id: string; started_at: Date }>(
    `insert into workflow_runs
       (id, namespace_id, workflow_type, input, idempotency_key, queue_name, search_attributes,
        memo, priority, singleton_key, idempotency_expires_at)
     values (coalesce($9::uuid, gen_random_uuid()), $1, $2, $3::jsonb, $4, $5, $6::jsonb,
             $7::jsonb, $8, $10, $11)
     on conflict (namespace_id, idempotency_key) where idempotency_key is not null
     do nothing
     returning id, started_at`,
    [
      input.namespaceId,
      input.workflowType,
      JSON.stringify(input.input ?? null),
      input.idempotencyKey ?? null,
      input.queueName,
      JSON.stringify(searchAttributes),
      memo === undefined ? null : JSON.stringify(memo),
      priority,
      input.runId ?? null,
      input.singletonKey ?? null,
      input.idempotencyExpiresAt ?? null,
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
    {
      type: "run_started",
      workflowType: input.workflowType,
      input: input.input ?? null,
      ...(Object.keys(searchAttributes).length === 0 ? {} : { searchAttributes }),
      ...(memo === undefined ? {} : { memo }),
    },
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
