import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  cancelRunOnClient,
  RunAlreadyClosedError,
  terminateRunOnClient,
} from "../cancellation/run-control.ts";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import { withTransaction } from "../db/transaction.ts";
import { requeueDeadLetterOnClient } from "../retry/dead-letters.ts";
import { insertRunOnClient } from "../run/insert-run.ts";
import { InvalidResetPointError, resetRunOnClient, type ResetPoint } from "../reset/reset-run.ts";
import {
  RunHistoryCompactedError,
  RunNotFoundError,
  RunNotOpenError,
  signalRunOnClient,
} from "../signals/signal-service.ts";
import { compileVisibilityQuery } from "../visibility/visibility-query.ts";
import { systemClock, type ClockSource } from "../workflow/sources.ts";

/**
 * The workflow type of the runs that execute batch operations. Runs of this
 * type are never targets of a batch.
 */
export const BATCH_WORKFLOW_TYPE = "dee.batch";

/**
 * The most runs one batch operation can target.
 */
export const MAX_BATCH_TARGETS = 100_000;

/**
 * How many targets a batch applies per step when it is not told otherwise.
 */
export const DEFAULT_BATCH_PAGE_SIZE = 100;

/**
 * What a batch does to each run it targets: request cancellation, terminate,
 * send a signal, reset to a step, or requeue the run's dead-lettered steps.
 */
export type BatchOperationKind = "cancel" | "terminate" | "signal" | "reset" | "requeue";

/**
 * The operations a batch can run, in the order the API documents them.
 */
export const BATCH_OPERATION_KINDS: readonly BatchOperationKind[] = [
  "cancel",
  "terminate",
  "signal",
  "reset",
  "requeue",
];

/**
 * The cut a batch reset applies to each run: before its `step`th step, or
 * before its first step that failed for good. An event sequence number is
 * not offered, since it means something different in every run.
 */
export type BatchResetPoint = Exclude<ResetPoint, { readonly kind: "event" }>;

/**
 * The signal a `signal` batch sends to each run. `payload` is stored and
 * delivered as given, so a caller with a payload codec encodes it first.
 */
export interface BatchSignal {
  readonly name: string;
  readonly payload?: unknown;
}

/**
 * What `startBatchOperationOnClient` needs. The targets are the runs of
 * `namespaceId` that match the visibility `query` when the batch starts,
 * oldest first; runs that match later are not added. `runsPerSecond` caps
 * how fast the batch applies its operation (unlimited by default) and
 * `pageSize` how many targets one step of the batch workflow handles
 * (`DEFAULT_BATCH_PAGE_SIZE`, never more than `runsPerSecond`). The batch
 * workflow runs on `queueName`.
 */
export interface StartBatchInput {
  readonly namespaceId: string;
  readonly operation: BatchOperationKind;
  readonly query: string;
  readonly queueName: string;
  readonly reason?: string | undefined;
  readonly signal?: BatchSignal | undefined;
  readonly resetPoint?: BatchResetPoint | undefined;
  readonly runsPerSecond?: number | undefined;
  readonly pageSize?: number | undefined;
}

/**
 * How far a batch has got: how many targets it applied its operation to,
 * how many it skipped (the run was closed, missing, or had nothing to
 * requeue or reset) and how many are left.
 */
export interface BatchProgress {
  readonly applied: number;
  readonly skipped: number;
  readonly remaining: number;
}

/**
 * A batch operation as `readBatchOperation` reports it. `runId` is the first
 * run of the batch workflow and `status` the status of the latest run of
 * its chain.
 */
export interface BatchOperation extends BatchProgress {
  readonly batchId: string;
  readonly namespaceId: string;
  readonly operation: BatchOperationKind;
  readonly query: string;
  readonly reason: string | null;
  readonly runId: string;
  readonly status: string;
  readonly total: number;
  readonly pageSize: number;
  readonly pageIntervalMs: number;
  readonly createdAt: Date;
}

/**
 * One run a batch targets, with what the batch did to it. `detail` says why
 * a target was skipped, or names the new run of a reset.
 */
export interface BatchTarget {
  readonly position: number;
  readonly runId: string;
  readonly state: "PENDING" | "APPLIED" | "SKIPPED";
  readonly detail: string | null;
  readonly appliedAt: Date | null;
}

/**
 * Raised when a batch operation is malformed: an unknown operation, a
 * signal batch without a signal name, a reset batch without a reset point,
 * a bad rate, or a query that matches more than `MAX_BATCH_TARGETS` runs.
 */
export class InvalidBatchOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBatchOperationError";
  }
}

/**
 * Raised when a batch operation id names no batch of the namespace.
 */
export class BatchOperationNotFoundError extends Error {
  readonly batchId: string;

  constructor(batchId: string) {
    super(`batch operation "${batchId}" does not exist`);
    this.name = "BatchOperationNotFoundError";
    this.batchId = batchId;
  }
}

interface BatchArguments {
  readonly signal?: BatchSignal;
  readonly resetPoint?: BatchResetPoint;
}

interface BatchRow {
  id: string;
  namespace_id: string;
  operation: BatchOperationKind;
  query: string;
  arguments: BatchArguments;
  reason: string | null;
  page_size: number;
  page_interval_ms: number;
  run_id: string;
  total: number;
  created_at: Date;
  status: string | null;
  applied: string;
  skipped: string;
  remaining: string;
}

/**
 * The page size and the pause between pages a batch uses: `pageSize` targets
 * per step, and with `runsPerSecond` a pause long enough that no more than
 * that many targets are applied per second.
 */
export function planBatchPages(
  runsPerSecond: number | undefined,
  pageSize: number = DEFAULT_BATCH_PAGE_SIZE,
): { readonly pageSize: number; readonly pageIntervalMs: number } {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new InvalidBatchOperationError("pageSize must be an integer between 1 and 1000");
  }
  if (runsPerSecond === undefined) {
    return { pageSize, pageIntervalMs: 0 };
  }
  if (!Number.isFinite(runsPerSecond) || runsPerSecond <= 0 || runsPerSecond > 100_000) {
    throw new InvalidBatchOperationError("runsPerSecond must be above 0 and at most 100000");
  }
  const size = Math.max(1, Math.min(pageSize, Math.floor(runsPerSecond)));
  return { pageSize: size, pageIntervalMs: Math.ceil((size * 1000) / runsPerSecond) };
}

function validateArguments(input: StartBatchInput): BatchArguments {
  if (!BATCH_OPERATION_KINDS.includes(input.operation)) {
    throw new InvalidBatchOperationError(`unknown batch operation "${input.operation}"`);
  }
  if (input.operation === "signal") {
    if (input.signal === undefined || input.signal.name.length === 0) {
      throw new InvalidBatchOperationError("a signal batch needs a signal name");
    }
    return { signal: { name: input.signal.name, payload: input.signal.payload ?? null } };
  }
  if (input.operation === "reset") {
    const point = input.resetPoint;
    if (point === undefined) {
      throw new InvalidBatchOperationError("a reset batch needs a reset point");
    }
    if (point.kind === "step" && (!Number.isInteger(point.step) || point.step < 1)) {
      throw new InvalidBatchOperationError("a reset batch's step must be a positive integer");
    }
    return { resetPoint: point };
  }
  return {};
}

/**
 * Starts a batch operation inside the caller's open transaction on
 * `client`: snapshots the matching runs as the batch's targets, records the
 * batch and starts its workflow run (`BATCH_WORKFLOW_TYPE`), which an engine
 * then executes page by page. Rejects with `InvalidBatchOperationError` or
 * `VisibilityQueryError`, writing nothing.
 */
export async function startBatchOperationOnClient(
  client: PoolClient,
  codec: Codec,
  input: StartBatchInput,
): Promise<BatchOperation> {
  const batchArguments = validateArguments(input);
  const plan = planBatchPages(input.runsPerSecond, input.pageSize);
  const batchId = randomUUID();
  const runId = randomUUID();
  const compiled =
    input.query.trim().length === 0 ? undefined : compileVisibilityQuery(input.query, 5);
  const inserted = await client.query<{ created_at: Date }>(
    `insert into batch_operations
       (id, namespace_id, operation, query, arguments, reason, page_size, page_interval_ms,
        run_id, total)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 0)
     returning created_at`,
    [
      batchId,
      input.namespaceId,
      input.operation,
      input.query,
      JSON.stringify(batchArguments),
      input.reason ?? null,
      plan.pageSize,
      plan.pageIntervalMs,
      runId,
    ],
  );
  const selected = await client.query<{ total: string }>(
    `with matched as (
       select id, created_at from workflow_runs
       where namespace_id = $1 and workflow_type <> $2 ${compiled === undefined ? "" : `and (${compiled.sql})`}
       order by created_at, id
       limit $4
     ), inserted as (
       insert into batch_operation_targets (batch_id, position, run_id)
       select $3::uuid, row_number() over (order by created_at, id), id from matched
       returning 1
     )
     select count(*) as total from inserted`,
    [
      input.namespaceId,
      BATCH_WORKFLOW_TYPE,
      batchId,
      MAX_BATCH_TARGETS + 1,
      ...(compiled?.values ?? []),
    ],
  );
  const total = Number(selected.rows[0]?.total ?? "0");
  if (total > MAX_BATCH_TARGETS) {
    throw new InvalidBatchOperationError(
      `the query matches more than ${String(MAX_BATCH_TARGETS)} runs; narrow it down`,
    );
  }
  await client.query("update batch_operations set total = $2 where id = $1", [batchId, total]);
  await insertRunOnClient(client, codec, {
    namespaceId: input.namespaceId,
    workflowType: BATCH_WORKFLOW_TYPE,
    input: { batchId },
    queueName: input.queueName,
    runId,
    taskReason: "batch",
    searchAttributes: { batchOperation: input.operation },
  });
  return {
    batchId,
    namespaceId: input.namespaceId,
    operation: input.operation,
    query: input.query,
    reason: input.reason ?? null,
    runId,
    status: "RUNNING",
    total,
    pageSize: plan.pageSize,
    pageIntervalMs: plan.pageIntervalMs,
    createdAt: inserted.rows[0]?.created_at ?? new Date(),
    applied: 0,
    skipped: 0,
    remaining: total,
  };
}

const BATCH_COLUMNS = `
  batch.*,
  (select status from workflow_runs chain
   where chain.first_run_id = batch.run_id order by chain.chain_index desc limit 1) as status,
  (select count(*) from batch_operation_targets target
   where target.batch_id = batch.id and target.state = 'APPLIED') as applied,
  (select count(*) from batch_operation_targets target
   where target.batch_id = batch.id and target.state = 'SKIPPED') as skipped,
  (select count(*) from batch_operation_targets target
   where target.batch_id = batch.id and target.state = 'PENDING') as remaining`;

function toBatchOperation(row: BatchRow): BatchOperation {
  return {
    batchId: row.id,
    namespaceId: row.namespace_id,
    operation: row.operation,
    query: row.query,
    reason: row.reason,
    runId: row.run_id,
    status: row.status ?? "RUNNING",
    total: row.total,
    pageSize: row.page_size,
    pageIntervalMs: row.page_interval_ms,
    createdAt: row.created_at,
    applied: Number(row.applied),
    skipped: Number(row.skipped),
    remaining: Number(row.remaining),
  };
}

/**
 * Reads the batch `batchId`, or `undefined` when it does not exist (or
 * belongs to another namespace when `namespaceId` is given).
 */
export async function readBatchOperation(
  pool: Pool,
  batchId: string,
  namespaceId?: string,
): Promise<BatchOperation | undefined> {
  const result = await pool.query<BatchRow>(
    `select ${BATCH_COLUMNS} from batch_operations batch
     where batch.id = $1 and ($2::uuid is null or batch.namespace_id = $2)`,
    [batchId, namespaceId ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toBatchOperation(row);
}

/**
 * Lists the batches of `namespaceId`, newest first, at most `limit`.
 */
export async function listBatchOperations(
  pool: Pool,
  namespaceId: string,
  limit = 50,
): Promise<BatchOperation[]> {
  const result = await pool.query<BatchRow>(
    `select ${BATCH_COLUMNS} from batch_operations batch
     where batch.namespace_id = $1
     order by batch.created_at desc, batch.id desc
     limit $2`,
    [namespaceId, limit],
  );
  return result.rows.map(toBatchOperation);
}

/**
 * Lists the targets of `batchId` in position order, after `afterPosition`,
 * at most `limit`.
 */
export async function listBatchTargets(
  pool: Pool,
  batchId: string,
  options: { readonly afterPosition?: number; readonly limit?: number } = {},
): Promise<BatchTarget[]> {
  const result = await pool.query<{
    position: number;
    run_id: string;
    state: BatchTarget["state"];
    detail: string | null;
    applied_at: Date | null;
  }>(
    `select position, run_id, state, detail, applied_at from batch_operation_targets
     where batch_id = $1 and position > $2
     order by position
     limit $3`,
    [batchId, options.afterPosition ?? 0, options.limit ?? 100],
  );
  return result.rows.map((row) => ({
    position: row.position,
    runId: row.run_id,
    state: row.state,
    detail: row.detail,
    appliedAt: row.applied_at,
  }));
}

class SkipTarget extends Error {}

function isSkippable(error: unknown): boolean {
  return (
    error instanceof SkipTarget ||
    error instanceof RunNotFoundError ||
    error instanceof RunAlreadyClosedError ||
    error instanceof RunNotOpenError ||
    error instanceof RunHistoryCompactedError ||
    error instanceof InvalidResetPointError
  );
}

async function applyToRun(
  client: PoolClient,
  codec: Codec,
  batch: BatchRow,
  runId: string,
  now: Date,
): Promise<string | null> {
  const reason = batch.reason ?? `batch ${batch.id}`;
  switch (batch.operation) {
    case "cancel": {
      const receipt = await cancelRunOnClient(client, codec, runId, reason);
      return receipt.requested ? null : "a cancellation was already pending";
    }
    case "terminate":
      await terminateRunOnClient(client, codec, runId, reason);
      return null;
    case "signal": {
      const signal = batch.arguments.signal;
      if (signal === undefined) {
        throw new SkipTarget("the batch has no signal");
      }
      const receipt = await signalRunOnClient(client, codec, runId, signal.name, signal.payload, {
        signalId: `batch-${batch.id}`,
      });
      return receipt.duplicate ? "the run already had this batch's signal" : null;
    }
    case "reset": {
      const point = batch.arguments.resetPoint;
      if (point === undefined) {
        throw new SkipTarget("the batch has no reset point");
      }
      const receipt = await resetRunOnClient(client, codec, { runId, point, reason }, now);
      return `reset to run ${receipt.runId}`;
    }
    case "requeue": {
      const letters = await client.query<{ id: string }>(
        "select id from dead_letters where run_id = $1 and requeued_at is null order by created_at, id",
        [runId],
      );
      if (letters.rows.length === 0) {
        throw new SkipTarget("the run has no dead-lettered step");
      }
      for (const letter of letters.rows) {
        await requeueDeadLetterOnClient(client, letter.id, now);
      }
      return `requeued ${String(letters.rows.length)} step(s)`;
    }
  }
}

async function applyNextTarget(
  pool: Pool,
  codec: Codec,
  batch: BatchRow,
  now: Date,
): Promise<"applied" | "skipped" | "none"> {
  return withTransaction(pool, async (client) => {
    const next = await client.query<{ position: number; run_id: string }>(
      `select position, run_id from batch_operation_targets
       where batch_id = $1 and state = 'PENDING'
       order by position
       limit 1
       for update skip locked`,
      [batch.id],
    );
    const target = next.rows[0];
    if (target === undefined) {
      return "none";
    }
    await client.query("savepoint batch_target");
    let state: "APPLIED" | "SKIPPED" = "APPLIED";
    let detail: string | null;
    try {
      detail = await applyToRun(client, codec, batch, target.run_id, now);
      await client.query("release savepoint batch_target");
    } catch (error) {
      if (!isSkippable(error)) {
        throw error;
      }
      await client.query("rollback to savepoint batch_target");
      state = "SKIPPED";
      detail = error instanceof Error ? error.message : String(error);
    }
    await client.query(
      `update batch_operation_targets set state = $3, detail = $4, applied_at = $5
       where batch_id = $1 and position = $2`,
      [batch.id, target.position, state, detail, now],
    );
    return state === "APPLIED" ? "applied" : "skipped";
  });
}

async function loadBatch(pool: Pool, batchId: string): Promise<BatchRow> {
  const result = await pool.query<BatchRow>(
    `select ${BATCH_COLUMNS} from batch_operations batch where batch.id = $1`,
    [batchId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new BatchOperationNotFoundError(batchId);
  }
  return row;
}

/**
 * Options for `createBatchOperationRunner`. `codec` must be the event codec
 * of the run histories the batch writes to.
 */
export interface BatchOperationRunnerOptions {
  readonly codec?: Codec;
  readonly clock?: ClockSource;
}

/**
 * Applies the operation of a batch to its targets. Each target is handled in
 * a transaction of its own that applies the operation and marks the target
 * done together, so a target is never applied twice, whatever crashes: a
 * transaction cut short leaves both undone, and the next attempt applies it.
 */
export interface BatchOperationRunner {
  /** The page size and the pause between pages the batch was started with. */
  plan(batchId: string): Promise<{ readonly pageSize: number; readonly pageIntervalMs: number }>;
  /**
   * Applies the operation to up to `limit` pending targets, oldest first,
   * and reports the batch's progress afterwards.
   */
  applyPage(batchId: string, limit: number): Promise<BatchProgress>;
}

/**
 * Creates a `BatchOperationRunner` over `pool`.
 */
export function createBatchOperationRunner(
  pool: Pool,
  options: BatchOperationRunnerOptions = {},
): BatchOperationRunner {
  const codec = options.codec ?? jsonCodec;
  const clock = options.clock ?? systemClock;
  return {
    async plan(batchId) {
      const batch = await loadBatch(pool, batchId);
      return { pageSize: batch.page_size, pageIntervalMs: batch.page_interval_ms };
    },

    async applyPage(batchId, limit) {
      const batch = await loadBatch(pool, batchId);
      for (let handled = 0; handled < limit; handled += 1) {
        if ((await applyNextTarget(pool, codec, batch, clock.now())) === "none") {
          break;
        }
      }
      const progress = await loadBatch(pool, batchId);
      return {
        applied: Number(progress.applied),
        skipped: Number(progress.skipped),
        remaining: Number(progress.remaining),
      };
    },
  };
}
