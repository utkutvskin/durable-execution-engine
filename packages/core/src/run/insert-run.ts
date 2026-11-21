import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.ts";
import { CURRENT_EVENT_VERSION } from "../event-store/event-version.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
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
 * The row `insert_run` returns for a new run.
 */
export interface InsertedRunRow {
  readonly id: string;
  readonly started_at: Date;
}

/**
 * The validated fields `insertRunStatement` writes: the input of
 * `insertRunOnClient` with its search attributes, memo and priority already
 * checked, and the run's `traceparent`.
 */
export interface InsertRunFields extends InsertRunInput {
  readonly searchAttributes: SearchAttributes;
  readonly priority: number;
  readonly traceparent: string | null;
}

/**
 * Builds the one statement that writes a run row, its `run_started` event
 * and its first workflow task (`insert_run`). It returns no row when
 * `idempotencyKey` already holds a run in the namespace.
 */
export function insertRunStatement(codec: Codec, fields: InsertRunFields): [string, unknown[]] {
  const started: WorkflowEvent = {
    type: "run_started",
    workflowType: fields.workflowType,
    input: fields.input ?? null,
    ...(Object.keys(fields.searchAttributes).length === 0
      ? {}
      : { searchAttributes: fields.searchAttributes }),
    ...(fields.memo === undefined ? {} : { memo: fields.memo }),
  };
  return [
    `select id, started_at from insert_run(
       $1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb, $8, $9::uuid, $10, $11, $12, $13, $14::jsonb,
       $15
     )`,
    [
      fields.namespaceId,
      fields.workflowType,
      JSON.stringify(fields.input ?? null),
      fields.idempotencyKey ?? null,
      fields.queueName,
      JSON.stringify(fields.searchAttributes),
      fields.memo === undefined ? null : JSON.stringify(fields.memo),
      fields.priority,
      fields.runId ?? null,
      fields.singletonKey ?? null,
      fields.idempotencyExpiresAt ?? null,
      codec.encode(started),
      CURRENT_EVENT_VERSION,
      JSON.stringify({ reason: fields.taskReason ?? "start" }),
      fields.traceparent,
    ],
  ];
}

/**
 * Writes a new run on `client` inside the caller's transaction: the run row
 * with its search attributes and memo, its `run_started` event and its first
 * workflow task in one statement (`insert_run`), then its timeout timers.
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
  const inserted = await client.query<InsertedRunRow>(
    ...insertRunStatement(codec, {
      ...input,
      searchAttributes,
      memo,
      priority,
      traceparent: null,
    }),
  );
  const created = inserted.rows[0];
  if (created === undefined) {
    return undefined;
  }
  await applyRunTimeoutsOnClient(client, created.id, created.started_at, {
    runTimeoutMs: input.runTimeoutMs,
    executionTimeoutMs: input.executionTimeoutMs,
  });
  return created.id;
}
