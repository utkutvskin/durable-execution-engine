import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import { appendEventsOnClient } from "../event-store/event-store.ts";
import { applyRunTimeoutsOnClient } from "../timeouts/run-timeouts.ts";
import { signalRunOnClient, type SignalReceipt } from "../signals/signal-service.ts";
import { cancelRunOnClient, type CancelReceipt } from "../cancellation/run-control.ts";

/**
 * The namespace `startWorkflow` uses when none is given.
 */
export const DEFAULT_EMBEDDED_NAMESPACE = "default";

/**
 * The queue `startWorkflow` enqueues on when none is given. It matches the
 * queue `startEngine` polls by default.
 */
export const DEFAULT_EMBEDDED_QUEUE = "default";

const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const NO_ACTIVE_TRANSACTION = "25P01";
const SAVEPOINT = "dee_embedded";

/**
 * Raised when `startWorkflow`, `signalWorkflow` or `cancelWorkflow` is
 * given a client that has no open transaction. Their writes only make sense
 * together with the caller's own, so they refuse to commit on their own.
 */
export class NoOpenTransactionError extends Error {
  constructor() {
    super(
      "the client has no open transaction: call `begin` before starting, signalling or cancelling a workflow on it",
    );
    this.name = "NoOpenTransactionError";
  }
}

/**
 * Raised when `startWorkflow` reuses an idempotency key that already
 * started a run of a different workflow type or with a different input.
 */
export class IdempotencyKeyConflictError extends Error {
  readonly idempotencyKey: string;
  readonly runId: string;

  constructor(idempotencyKey: string, runId: string) {
    super(
      `idempotency key "${idempotencyKey}" already started run "${runId}" with a different workflow type or input`,
    );
    this.name = "IdempotencyKeyConflictError";
    this.idempotencyKey = idempotencyKey;
    this.runId = runId;
  }
}

/**
 * Options every transactional call takes. `schema` names the Postgres
 * schema that holds the engine tables when it differs from the caller's
 * `search_path`, for example `dee` next to an application's `public`. The
 * schema is used only for the engine's own statements: the caller's
 * `search_path` is the same after the call as before it. `codec` must be the
 * codec the engine reads history with (default `jsonCodec`).
 */
export interface EmbeddedOptions {
  readonly schema?: string | undefined;
  readonly codec?: Codec | undefined;
}

/**
 * What `startWorkflow` starts. `namespace` is a namespace name, created when
 * it does not exist yet (default `"default"`). `queueName` is the queue the
 * first workflow task goes to (default `"default"`). A repeated
 * `idempotencyKey` in the same namespace returns the run it started.
 */
export interface StartWorkflowInput extends EmbeddedOptions {
  readonly workflowType: string;
  readonly input?: unknown;
  readonly namespace?: string | undefined;
  readonly queueName?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly runTimeoutMs?: number | undefined;
  readonly executionTimeoutMs?: number | undefined;
}

/**
 * What `startWorkflow` returns. `created` is false when the idempotency key
 * had already started `runId`.
 */
export interface StartWorkflowResult {
  readonly runId: string;
  readonly created: boolean;
}

/**
 * What `signalWorkflow` sends.
 */
export interface SignalWorkflowInput extends EmbeddedOptions {
  readonly runId: string;
  readonly signalName: string;
  readonly payload?: unknown;
}

/**
 * What `cancelWorkflow` cancels.
 */
export interface CancelWorkflowInput extends EmbeddedOptions {
  readonly runId: string;
  readonly reason?: string | undefined;
}

interface ExistingRunRow {
  id: string;
  workflow_type: string;
  input: unknown;
}

function quoteSchema(schema: string): string {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new RangeError(
      `schema must be a plain identifier of letters, digits and underscores, got "${schema}"`,
    );
  }
  return `"${schema}"`;
}

function isNoActiveTransaction(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === NO_ACTIVE_TRANSACTION
  );
}

/**
 * Runs `work` on the caller's open transaction inside a savepoint, with the
 * engine schema in front when one is given. A throw rolls back to the
 * savepoint, so a failed call leaves the caller's transaction usable and
 * without any of the engine's writes. Rejects with `NoOpenTransactionError`
 * when `client` is not inside a transaction.
 */
async function inEmbeddedTransaction<T>(
  client: PoolClient,
  options: EmbeddedOptions,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const searchPath = options.schema === undefined ? undefined : quoteSchema(options.schema);
  try {
    await client.query(`savepoint ${SAVEPOINT}`);
  } catch (error) {
    if (isNoActiveTransaction(error)) {
      throw new NoOpenTransactionError();
    }
    throw error;
  }
  try {
    let previous: string | undefined;
    if (searchPath !== undefined) {
      const current = await client.query<{ search_path: string }>(
        "select current_setting('search_path') as search_path",
      );
      previous = current.rows[0]?.search_path ?? "";
      await client.query("select set_config('search_path', $1, true)", [searchPath]);
    }
    const result = await work(client);
    if (previous !== undefined) {
      await client.query("select set_config('search_path', $1, true)", [previous]);
    }
    await client.query(`release savepoint ${SAVEPOINT}`);
    return result;
  } catch (error) {
    await client.query(`rollback to savepoint ${SAVEPOINT}`).catch(() => undefined);
    await client.query(`release savepoint ${SAVEPOINT}`).catch(() => undefined);
    throw error;
  }
}

async function resolveNamespace(client: PoolClient, name: string): Promise<string> {
  const existing = await client.query<{ id: string }>("select id from namespaces where name = $1", [
    name,
  ]);
  const found = existing.rows[0]?.id;
  if (found !== undefined) {
    return found;
  }
  const inserted = await client.query<{ id: string }>(
    `insert into namespaces (name) values ($1)
     on conflict (name) do update set name = excluded.name
     returning id`,
    [name],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error(`namespace "${name}" could not be created`);
  }
  return id;
}

async function findByKey(
  client: PoolClient,
  namespaceId: string,
  input: StartWorkflowInput,
  idempotencyKey: string,
): Promise<StartWorkflowResult> {
  const existing = await client.query<ExistingRunRow>(
    `select id, workflow_type, input from workflow_runs
     where namespace_id = $1 and idempotency_key = $2`,
    [namespaceId, idempotencyKey],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(`idempotency key "${idempotencyKey}" was taken but no run holds it`);
  }
  const sameRequest =
    row.workflow_type === input.workflowType && isDeepStrictEqual(row.input, input.input ?? null);
  if (!sameRequest) {
    throw new IdempotencyKeyConflictError(idempotencyKey, row.id);
  }
  return { runId: row.id, created: false };
}

/**
 * Starts a workflow run inside the caller's open transaction on `client`:
 * the run row, its `run_started` event, its timeout timers and its first
 * workflow task are written there and commit or roll back together with the
 * caller's own writes. Nothing runs before the caller commits, because a
 * worker cannot see the task until then. The caller owns `begin`, `commit`
 * and `rollback`. Rejects with `NoOpenTransactionError` outside a
 * transaction, `IdempotencyKeyConflictError` for a key reused with another
 * request, and `RangeError` for an empty workflow type or a bad timeout.
 */
export async function startWorkflow(
  client: PoolClient,
  input: StartWorkflowInput,
): Promise<StartWorkflowResult> {
  if (input.workflowType.length === 0) {
    throw new RangeError("workflowType must not be empty");
  }
  const codec = input.codec ?? jsonCodec;
  const queueName = input.queueName ?? DEFAULT_EMBEDDED_QUEUE;
  return inEmbeddedTransaction(client, input, async () => {
    const namespaceId = await resolveNamespace(
      client,
      input.namespace ?? DEFAULT_EMBEDDED_NAMESPACE,
    );
    const inserted = await client.query<{ id: string; started_at: Date }>(
      `insert into workflow_runs
         (namespace_id, workflow_type, input, idempotency_key, queue_name)
       values ($1, $2, $3::jsonb, $4, $5)
       on conflict (namespace_id, idempotency_key) where idempotency_key is not null
       do nothing
       returning id, started_at`,
      [
        namespaceId,
        input.workflowType,
        JSON.stringify(input.input ?? null),
        input.idempotencyKey ?? null,
        queueName,
      ],
    );
    const created = inserted.rows[0];
    if (created === undefined) {
      return findByKey(client, namespaceId, input, input.idempotencyKey ?? "");
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
      [namespaceId, created.id, queueName, JSON.stringify({ reason: "start" })],
    );
    return { runId: created.id, created: true };
  });
}

/**
 * Sends a signal to a run inside the caller's open transaction on `client`:
 * the `signal_received` event and the workflow task that delivers it commit
 * or roll back with the caller's writes. The run row stays locked until the
 * caller's transaction ends. Rejects with `NoOpenTransactionError`,
 * `RunNotFoundError` or `RunNotOpenError`.
 */
export async function signalWorkflow(
  client: PoolClient,
  input: SignalWorkflowInput,
): Promise<SignalReceipt> {
  const codec = input.codec ?? jsonCodec;
  return inEmbeddedTransaction(client, input, () =>
    signalRunOnClient(client, codec, input.runId, input.signalName, input.payload ?? null),
  );
}

/**
 * Requests graceful cancellation of a run inside the caller's open
 * transaction on `client`: `cancel_requested` and its workflow task commit
 * or roll back with the caller's writes. Asking again while a request is
 * pending writes nothing. Rejects with `NoOpenTransactionError`,
 * `RunNotFoundError` or `RunAlreadyClosedError`.
 */
export async function cancelWorkflow(
  client: PoolClient,
  input: CancelWorkflowInput,
): Promise<CancelReceipt> {
  const codec = input.codec ?? jsonCodec;
  return inEmbeddedTransaction(client, input, () =>
    cancelRunOnClient(client, codec, input.runId, input.reason),
  );
}
