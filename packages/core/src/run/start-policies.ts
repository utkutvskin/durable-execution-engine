import type { Pool, PoolClient } from "pg";
import type { Codec } from "../event-store/codec.ts";
import { jsonCodec } from "../event-store/codec.ts";
import { withTransaction } from "../db/transaction.ts";
import { systemClock, type ClockSource } from "../workflow/sources.ts";
import type { SearchAttributes } from "../visibility/search-attributes.ts";
import { insertRunOnClient } from "./insert-run.ts";

/**
 * Debounces starts that share `key` in a namespace: the first start opens a
 * window of `windowMs`, every start inside the window replaces the input,
 * and when the window closes one run starts with the last input. The window
 * is counted from the first start and is not extended by later ones.
 */
export interface DebounceStart {
  readonly key: string;
  readonly windowMs: number;
}

/**
 * What a singleton start does while a run with its key is open: `refuse`
 * rejects it with `SingletonRunOpenError`, `queue` records it and starts it
 * once no run of the key is open, in the order the starts arrived.
 */
export type SingletonWhenOpen = "refuse" | "queue";

/**
 * Allows at most one open run per `key` in a namespace.
 * `whenOpen` defaults to `refuse`.
 */
export interface SingletonStart {
  readonly key: string;
  readonly whenOpen?: SingletonWhenOpen;
}

/**
 * The start options that decide whether and when a start creates a run.
 * `idempotencyTtlMs` limits how long `idempotencyKey` maps to the run it
 * started: a start after the TTL creates a new run and takes the key over.
 * `debounce` cannot be combined with `singleton` or an idempotency key, and
 * a queued singleton cannot carry an idempotency key, because neither
 * creates its run during the call.
 */
export interface StartPolicies {
  readonly idempotencyKey?: string | undefined;
  readonly idempotencyTtlMs?: number | undefined;
  readonly debounce?: DebounceStart | undefined;
  readonly singleton?: SingletonStart | undefined;
}

/**
 * The options of a run that a pending start keeps until it fires.
 */
export interface PendingRunOptions {
  readonly runTimeoutMs?: number | undefined;
  readonly executionTimeoutMs?: number | undefined;
  readonly searchAttributes?: SearchAttributes | undefined;
  readonly memo?: unknown;
  readonly priority?: number | undefined;
}

/**
 * A start that has not created its run yet. `runId` is the id the run gets
 * when it starts. `fireAt` is when a debounced start fires; a queued
 * singleton start has none. `startCount` counts the starts a debounced
 * window absorbed.
 */
export interface PendingStart {
  readonly runId: string;
  readonly kind: "debounce" | "singleton";
  readonly key: string;
  readonly workflowType: string;
  readonly fireAt: Date | null;
  readonly startCount: number;
}

/**
 * The longest debounce or singleton key, in characters.
 */
export const MAX_START_KEY_LENGTH = 256;

/**
 * Thrown when start policies are malformed or combined in a way that is not
 * supported.
 */
export class InvalidStartPolicyError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStartPolicyError";
  }
}

/**
 * Thrown when a singleton start with `whenOpen: "refuse"` finds a run with
 * its key open, or starts queued before it. `runId` is the open run, when
 * there is one.
 */
export class SingletonRunOpenError extends Error {
  readonly key: string;
  readonly runId: string | undefined;

  constructor(key: string, runId: string | undefined) {
    super(
      runId === undefined
        ? `singleton key "${key}" has queued starts waiting for a run to close`
        : `singleton key "${key}" already has the open run "${runId}"`,
    );
    this.name = "SingletonRunOpenError";
    this.key = key;
    this.runId = runId;
  }
}

function validateKey(owner: string, key: unknown): void {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_START_KEY_LENGTH) {
    throw new InvalidStartPolicyError(
      `${owner} key must be a string of 1 to ${String(MAX_START_KEY_LENGTH)} characters`,
    );
  }
}

function validateDuration(owner: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidStartPolicyError(`${owner} must be a positive integer of milliseconds`);
  }
}

/**
 * Checks `policies` and rejects with `InvalidStartPolicyError` when one is
 * malformed or the combination is not supported (see `StartPolicies`).
 */
export function validateStartPolicies(policies: StartPolicies): void {
  if (policies.idempotencyTtlMs !== undefined) {
    validateDuration("idempotencyTtlMs", policies.idempotencyTtlMs);
    if (policies.idempotencyKey === undefined) {
      throw new InvalidStartPolicyError("idempotencyTtlMs needs an idempotency key");
    }
  }
  if (policies.debounce !== undefined) {
    validateKey("debounce", policies.debounce.key);
    validateDuration("debounce windowMs", policies.debounce.windowMs);
    if (policies.singleton !== undefined) {
      throw new InvalidStartPolicyError("debounce cannot be combined with singleton");
    }
    if (policies.idempotencyKey !== undefined) {
      throw new InvalidStartPolicyError("debounce cannot be combined with an idempotency key");
    }
  }
  if (policies.singleton !== undefined) {
    validateKey("singleton", policies.singleton.key);
    const whenOpen: unknown = policies.singleton.whenOpen ?? "refuse";
    if (whenOpen !== "refuse" && whenOpen !== "queue") {
      throw new InvalidStartPolicyError(`singleton whenOpen must be "refuse" or "queue"`);
    }
    if (whenOpen === "queue" && policies.idempotencyKey !== undefined) {
      throw new InvalidStartPolicyError(
        "a queued singleton start cannot be combined with an idempotency key",
      );
    }
  }
}

/**
 * Frees `idempotencyKey` in the namespace when the run holding it has an
 * expired TTL at `now`, so the next insert can take it. The expired run
 * keeps its `idempotency_expires_at` and loses the key.
 */
export async function releaseExpiredIdempotencyKeyOnClient(
  client: PoolClient,
  namespaceId: string,
  idempotencyKey: string,
  now: Date,
): Promise<void> {
  await client.query(
    `update workflow_runs set idempotency_key = null
     where namespace_id = $1 and idempotency_key = $2 and idempotency_expires_at <= $3`,
    [namespaceId, idempotencyKey, now],
  );
}

/**
 * The SQL condition, over `workflow_runs`, under which a run's idempotency
 * key still maps to it at the timestamp in parameter `$nowParameter`.
 */
export function liveIdempotencyKeyCondition(nowParameter: number): string {
  return `(idempotency_expires_at is null or idempotency_expires_at > $${String(nowParameter)}::timestamptz)`;
}

/**
 * The start a caller asked for, as far as `admitStartOnClient` needs it.
 */
export interface StartRequest {
  readonly namespaceId: string;
  readonly workflowType: string;
  readonly input: unknown;
  readonly queueName: string;
  readonly options: PendingRunOptions;
}

/**
 * The outcome of `admitStartOnClient`: `start` tells the caller to insert
 * the run now, with `singletonKey` on it when given; `pending` means the
 * start was recorded and creates its run later.
 */
export type StartAdmission =
  | { readonly kind: "start"; readonly singletonKey?: string }
  | { readonly kind: "pending"; readonly pending: PendingStart };

interface PendingRow {
  id: string;
  namespace_id: string;
  kind: "debounce" | "singleton";
  start_key: string;
  workflow_type: string;
  input: unknown;
  queue_name: string;
  options: PendingRunOptions;
  fire_at: Date | null;
  start_count: number;
}

const PENDING_COLUMNS = `id, namespace_id, kind, start_key, workflow_type, input, queue_name,
  options, fire_at, start_count`;

function toPending(row: PendingRow): PendingStart {
  return {
    runId: row.id,
    kind: row.kind,
    key: row.start_key,
    workflowType: row.workflow_type,
    fireAt: row.fire_at,
    startCount: row.start_count,
  };
}

async function lockStartKey(
  client: PoolClient,
  scope: "debounce" | "singleton",
  namespaceId: string,
  key: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `${scope}:${namespaceId}:${key}`,
  ]);
}

async function firePendingOnClient(
  client: PoolClient,
  codec: Codec,
  row: PendingRow,
  singletonKey: string | undefined,
): Promise<string> {
  const runId = await insertRunOnClient(client, codec, {
    runId: row.id,
    namespaceId: row.namespace_id,
    workflowType: row.workflow_type,
    input: row.input,
    queueName: row.queue_name,
    taskReason: row.kind,
    runTimeoutMs: row.options.runTimeoutMs,
    executionTimeoutMs: row.options.executionTimeoutMs,
    searchAttributes: row.options.searchAttributes,
    memo: row.options.memo,
    priority: row.options.priority,
    singletonKey,
  });
  if (runId === undefined) {
    throw new Error(`pending start ${row.id} could not insert its run`);
  }
  await client.query("delete from pending_starts where id = $1", [row.id]);
  return runId;
}

async function insertPending(
  client: PoolClient,
  request: StartRequest,
  kind: "debounce" | "singleton",
  key: string,
  fireAt: Date | null,
  now: Date,
): Promise<PendingStart> {
  const inserted = await client.query<PendingRow>(
    `insert into pending_starts
       (namespace_id, kind, start_key, workflow_type, input, queue_name, options, fire_at,
        created_at, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $9)
     returning ${PENDING_COLUMNS}`,
    [
      request.namespaceId,
      kind,
      key,
      request.workflowType,
      JSON.stringify(request.input ?? null),
      request.queueName,
      JSON.stringify(request.options),
      fireAt,
      now,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error("pending start insert returned no row");
  }
  return toPending(row);
}

async function admitDebounced(
  client: PoolClient,
  codec: Codec,
  request: StartRequest,
  debounce: DebounceStart,
  now: Date,
): Promise<StartAdmission> {
  await lockStartKey(client, "debounce", request.namespaceId, debounce.key);
  const existing = await client.query<PendingRow>(
    `select ${PENDING_COLUMNS} from pending_starts
     where namespace_id = $1 and kind = 'debounce' and start_key = $2
     for update`,
    [request.namespaceId, debounce.key],
  );
  const open = existing.rows[0];
  if (open !== undefined && open.fire_at !== null && open.fire_at > now) {
    const updated = await client.query<PendingRow>(
      `update pending_starts
       set workflow_type = $2, input = $3::jsonb, queue_name = $4, options = $5::jsonb,
           start_count = start_count + 1, updated_at = $6
       where id = $1
       returning ${PENDING_COLUMNS}`,
      [
        open.id,
        request.workflowType,
        JSON.stringify(request.input ?? null),
        request.queueName,
        JSON.stringify(request.options),
        now,
      ],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new Error(`debounced start ${open.id} vanished under its lock`);
    }
    return { kind: "pending", pending: toPending(row) };
  }
  if (open !== undefined) {
    await firePendingOnClient(client, codec, open, undefined);
  }
  const fireAt = new Date(now.getTime() + debounce.windowMs);
  return {
    kind: "pending",
    pending: await insertPending(client, request, "debounce", debounce.key, fireAt, now),
  };
}

async function openSingletonRun(
  client: PoolClient,
  namespaceId: string,
  key: string,
): Promise<string | undefined> {
  const open = await client.query<{ id: string }>(
    `select id from workflow_runs
     where namespace_id = $1 and singleton_key = $2 and status = 'RUNNING'
     limit 1`,
    [namespaceId, key],
  );
  return open.rows[0]?.id;
}

async function hasQueuedSingleton(
  client: PoolClient,
  namespaceId: string,
  key: string,
): Promise<boolean> {
  const queued = await client.query(
    `select 1 from pending_starts
     where namespace_id = $1 and kind = 'singleton' and start_key = $2
     limit 1`,
    [namespaceId, key],
  );
  return (queued.rowCount ?? 0) > 0;
}

async function admitSingleton(
  client: PoolClient,
  request: StartRequest,
  singleton: SingletonStart,
  now: Date,
): Promise<StartAdmission> {
  await lockStartKey(client, "singleton", request.namespaceId, singleton.key);
  const openRunId = await openSingletonRun(client, request.namespaceId, singleton.key);
  const queued = await hasQueuedSingleton(client, request.namespaceId, singleton.key);
  if (openRunId === undefined && !queued) {
    return { kind: "start", singletonKey: singleton.key };
  }
  if ((singleton.whenOpen ?? "refuse") === "refuse") {
    throw new SingletonRunOpenError(singleton.key, openRunId);
  }
  return {
    kind: "pending",
    pending: await insertPending(client, request, "singleton", singleton.key, null, now),
  };
}

/**
 * Applies `policies` to a start inside the caller's transaction on
 * `client`, at `now`. A debounced start is recorded or merged into the open
 * window of its key (a window that is already due is fired first). A
 * singleton start is admitted when no run of its key is open and nothing is
 * queued for it; otherwise it is refused or queued. The debounce and
 * singleton paths serialize on a transaction scoped advisory lock per key,
 * so concurrent starts see each other. `policies` must have passed
 * `validateStartPolicies`.
 */
export async function admitStartOnClient(
  client: PoolClient,
  request: StartRequest,
  policies: StartPolicies,
  now: Date,
  codec: Codec = jsonCodec,
): Promise<StartAdmission> {
  if (policies.idempotencyKey !== undefined) {
    await releaseExpiredIdempotencyKeyOnClient(
      client,
      request.namespaceId,
      policies.idempotencyKey,
      now,
    );
  }
  if (policies.debounce !== undefined) {
    return admitDebounced(client, codec, request, policies.debounce, now);
  }
  if (policies.singleton !== undefined) {
    return admitSingleton(client, request, policies.singleton, now);
  }
  return { kind: "start" };
}

/**
 * What one `firePendingStarts` pass started: the run ids of fired debounced
 * windows and of queued singleton starts whose key had no open run.
 */
export interface PendingStartReport {
  readonly debounced: readonly string[];
  readonly singletons: readonly string[];
}

/**
 * Options for `createPendingStartFirer`. `batchSize` (default 100) caps the
 * debounced windows and the singleton keys handled per pass.
 */
export interface PendingStartFirerOptions {
  readonly clock?: ClockSource;
  readonly codec?: Codec;
  readonly batchSize?: number;
}

/**
 * Starts the runs of pending starts that may start now.
 */
export interface PendingStartFirer {
  /**
   * Fires every debounced window that is due and, for each singleton key
   * with queued starts and no open run, the oldest queued start. Each start
   * fires in its own transaction; a window or key another process is firing
   * is skipped.
   */
  fireDue(): Promise<PendingStartReport>;
}

/**
 * Creates a `PendingStartFirer` over `pool`.
 */
export function createPendingStartFirer(
  pool: Pool,
  options: PendingStartFirerOptions = {},
): PendingStartFirer {
  const clock = options.clock ?? systemClock;
  const codec = options.codec ?? jsonCodec;
  const batchSize = options.batchSize ?? 100;

  async function fireDebounced(): Promise<string[]> {
    const fired: string[] = [];
    for (let index = 0; index < batchSize; index += 1) {
      const runId = await withTransaction(pool, async (client) => {
        const due = await client.query<PendingRow>(
          `select ${PENDING_COLUMNS} from pending_starts
           where kind = 'debounce' and fire_at <= $1
           order by fire_at
           limit 1
           for update skip locked`,
          [clock.now()],
        );
        const row = due.rows[0];
        return row === undefined ? undefined : firePendingOnClient(client, codec, row, undefined);
      });
      if (runId === undefined) {
        break;
      }
      fired.push(runId);
    }
    return fired;
  }

  async function fireSingleton(namespaceId: string, key: string): Promise<string | undefined> {
    return withTransaction(pool, async (client) => {
      await lockStartKey(client, "singleton", namespaceId, key);
      if ((await openSingletonRun(client, namespaceId, key)) !== undefined) {
        return undefined;
      }
      const next = await client.query<PendingRow>(
        `select ${PENDING_COLUMNS} from pending_starts
         where namespace_id = $1 and kind = 'singleton' and start_key = $2
         order by seq
         limit 1
         for update`,
        [namespaceId, key],
      );
      const row = next.rows[0];
      return row === undefined ? undefined : firePendingOnClient(client, codec, row, key);
    });
  }

  return {
    async fireDue(): Promise<PendingStartReport> {
      const debounced = await fireDebounced();
      const keys = await pool.query<{ namespace_id: string; start_key: string }>(
        `select distinct namespace_id, start_key from pending_starts
         where kind = 'singleton'
         limit $1`,
        [batchSize],
      );
      const singletons: string[] = [];
      for (const row of keys.rows) {
        const runId = await fireSingleton(row.namespace_id, row.start_key);
        if (runId !== undefined) {
          singletons.push(runId);
        }
      }
      return { debounced, singletons };
    },
  };
}

/**
 * Reads a pending start by the run id it will start, or `undefined` when no
 * start is pending under that id (it fired, or never existed).
 */
export async function readPendingStart(
  pool: Pool,
  namespaceId: string,
  runId: string,
): Promise<PendingStart | undefined> {
  const result = await pool.query<PendingRow>(
    `select ${PENDING_COLUMNS} from pending_starts where id = $1 and namespace_id = $2`,
    [runId, namespaceId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toPending(row);
}
