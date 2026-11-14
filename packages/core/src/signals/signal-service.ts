import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import {
  appendEventsOnClient,
  createPostgresEventStore,
  readCurrentSequenceOnClient,
} from "../event-store/event-store.ts";
import type { ClockSource, RandomSource } from "../workflow/sources.ts";
import { runQuery } from "../workflow/query.ts";
import type { WorkflowRegistry } from "../workflow/workflow-registry.ts";
import { rollbackQuietly } from "../db/transaction.ts";
import { insertRunOnClient } from "../run/insert-run.ts";
import {
  acceptUpdateOnClient,
  awaitUpdateOutcome,
  updateWaitMs,
  WorkflowNotLoadedError,
  type UpdateCallOptions,
  type UpdateOutcome,
  type UpdateWaitOptions,
} from "./update-service.ts";

/**
 * Raised when a query names a run whose history was compacted, so the
 * workflow cannot be replayed to answer it.
 */
export class RunHistoryCompactedError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `workflow run "${runId}" has a compacted history: a query needs the whole history to replay, so it can only be answered while the run keeps its first event`,
    );
    this.name = "RunHistoryCompactedError";
    this.runId = runId;
  }
}

/**
 * Raised when a signal or query names a run that does not exist.
 */
export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`workflow run "${runId}" does not exist`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

/**
 * Raised when a signal is sent to a run that already reached a terminal
 * state.
 */
export class RunNotOpenError extends Error {
  readonly runId: string;
  readonly status: string;

  constructor(runId: string, status: string) {
    super(`workflow run "${runId}" is ${status} and cannot receive signals`);
    this.name = "RunNotOpenError";
    this.runId = runId;
    this.status = status;
  }
}

/**
 * What `signalRun` returns: the run that received the signal (the current
 * run of the chain when the addressed run continued as new), and the
 * sequence number of its `signal_received` event. `duplicate` is true when
 * the signal id was already used in the run's chain: nothing was written and
 * the receipt names the first signal with that id.
 */
export interface SignalReceipt {
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly duplicate: boolean;
}

/**
 * Options for a signal. `signalId` deduplicates: a second signal with the
 * same id anywhere in the run's continue-as-new chain is not recorded again.
 */
export interface SignalOptions {
  readonly signalId?: string | undefined;
}

/**
 * What `signalWithStart` sends: the signal, and the run to start when no run
 * holds `workflowKey` in the namespace yet. `workflowKey` is the run's
 * idempotency key, so a later `startRun` with the same key finds it too.
 */
export interface SignalWithStartInput {
  readonly namespaceId: string;
  readonly workflowType: string;
  readonly workflowKey: string;
  readonly input?: unknown;
  readonly queueName?: string | undefined;
  readonly signalName: string;
  readonly payload?: unknown;
  readonly signalId?: string | undefined;
}

/**
 * What `signalWithStart` returns: the signal receipt and whether this call
 * started the run.
 */
export interface SignalWithStartReceipt extends SignalReceipt {
  readonly created: boolean;
}

/**
 * Raised when `signalWithStart` names a `workflowKey` that already holds a
 * run of a different workflow type.
 */
export class WorkflowKeyConflictError extends Error {
  readonly workflowKey: string;
  readonly runId: string;

  constructor(workflowKey: string, runId: string, workflowType: string) {
    super(
      `workflow key "${workflowKey}" already holds run "${runId}" of workflow type "${workflowType}"`,
    );
    this.name = "WorkflowKeyConflictError";
    this.workflowKey = workflowKey;
    this.runId = runId;
  }
}

/**
 * Sends signals and updates to runs and reads queries from them.
 */
export interface RunInteractions {
  /**
   * Records a `signal_received` event on `runId` and enqueues a workflow
   * task so the run reacts to it, in one transaction. The signal is kept in
   * the history whether or not the run is waiting yet. A run that continued
   * as new forwards the signal to the current run of its chain. A repeated
   * `options.signalId` writes nothing. Rejects with `RunNotFoundError` or
   * `RunNotOpenError`.
   */
  signalRun(
    runId: string,
    signalName: string,
    payload?: unknown,
    options?: SignalOptions,
  ): Promise<SignalReceipt>;

  /**
   * Signals the open run that holds `input.workflowKey`, starting it first
   * when no run holds the key yet, in one transaction. Concurrent calls with
   * the same key start exactly one run and every signal reaches it. Rejects
   * with `RunNotOpenError` when the run of the key (and its chain) closed,
   * and `WorkflowKeyConflictError` when the key holds another workflow type.
   */
  signalWithStart(input: SignalWithStartInput): Promise<SignalWithStartReceipt>;

  /**
   * Replays the run's history and answers the named query from the
   * workflow's state at its current point. Reads only: no event, task or
   * row is written. Rejects with `RunNotFoundError` or `UnknownQueryError`.
   */
  queryRun(runId: string, queryName: string, argument?: unknown): Promise<unknown>;

  /**
   * Validates the update `updateName` against the run's current state,
   * records `update_accepted` and enqueues a workflow task in one
   * transaction, then waits up to `options.waitMs` for the handler's
   * outcome. A rejected update writes nothing. Rejects with
   * `RunNotFoundError`, `RunNotOpenError`, `RunHistoryCompactedError`,
   * `WorkflowNotLoadedError`, `UnknownUpdateError` or `UpdateRejectedError`.
   */
  updateRun(
    runId: string,
    updateName: string,
    argument?: unknown,
    options?: UpdateCallOptions,
  ): Promise<UpdateOutcome>;
}

/**
 * Options for `createRunInteractions`. The `WORKFLOW_TASK` of a signal goes
 * to the queue of the run it is sent to. `clock` and `random` serve
 * `ctx.now()`, `ctx.random()` and `ctx.uuid()` while a query replays.
 */
export interface RunInteractionsOptions {
  readonly workflows: WorkflowRegistry;
  readonly clock: ClockSource;
  readonly random: RandomSource;
  readonly codec?: Codec;
  readonly updateWait?: UpdateWaitOptions;
}

interface RunRow {
  namespace_id: string;
  workflow_type: string;
  status: string;
  queue_name: string;
  first_run_id: string;
}

const MAX_CHAIN_HOPS = 1000;

async function lockOpenRunOfChain(
  client: PoolClient,
  runId: string,
): Promise<{ readonly runId: string; readonly row: RunRow }> {
  let current = runId;
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    const run = await client.query<RunRow>(
      `select namespace_id, workflow_type, status, queue_name, first_run_id
       from workflow_runs where id = $1 for update`,
      [current],
    );
    const row = run.rows[0];
    if (row === undefined) {
      throw new RunNotFoundError(current);
    }
    if (row.status === "RUNNING") {
      return { runId: current, row };
    }
    if (row.status !== "CONTINUED_AS_NEW") {
      throw new RunNotOpenError(current, row.status);
    }
    const next = await client.query<{ id: string }>(
      "select id from workflow_runs where continued_from_run_id = $1",
      [current],
    );
    const successor = next.rows[0]?.id;
    if (successor === undefined) {
      throw new RunNotOpenError(current, row.status);
    }
    current = successor;
  }
  throw new RunNotOpenError(current, "CONTINUED_AS_NEW");
}

/**
 * Records a `signal_received` event on `runId` and enqueues a workflow task
 * for it inside the caller's open transaction on `client`, taking the run
 * row lock. A run that continued as new forwards the signal to the current
 * run of its chain. A `signalId` already used in the chain writes nothing
 * and returns the first receipt with `duplicate: true`. Rejects with
 * `RunNotFoundError` or `RunNotOpenError`.
 */
export async function signalRunOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
  signalName: string,
  payload: unknown = null,
  options: SignalOptions = {},
): Promise<SignalReceipt> {
  const open = await lockOpenRunOfChain(client, runId);
  const { row } = open;
  if (options.signalId !== undefined) {
    const seen = await client.query<{ run_id: string; sequence_number: string }>(
      "select run_id, sequence_number from signal_ids where first_run_id = $1 and signal_id = $2",
      [row.first_run_id, options.signalId],
    );
    const first = seen.rows[0];
    if (first !== undefined) {
      return {
        runId: first.run_id,
        sequenceNumber: Number(first.sequence_number),
        duplicate: true,
      };
    }
  }
  const currentSeq = await readCurrentSequenceOnClient(client, open.runId);
  const [stored] = await appendEventsOnClient(client, codec, open.runId, currentSeq, [
    options.signalId === undefined
      ? { type: "signal_received", signalName, payload }
      : { type: "signal_received", signalName, payload, signalId: options.signalId },
  ]);
  const sequenceNumber = stored?.sequenceNumber ?? currentSeq + 1;
  if (options.signalId !== undefined) {
    await client.query(
      `insert into signal_ids (first_run_id, signal_id, run_id, sequence_number)
       values ($1, $2, $3, $4)`,
      [row.first_run_id, options.signalId, open.runId, sequenceNumber],
    );
  }
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [
      row.namespace_id,
      open.runId,
      row.queue_name,
      JSON.stringify({ reason: "signal", signalName }),
    ],
  );
  return { runId: open.runId, sequenceNumber, duplicate: false };
}

/**
 * Signal-with-start inside the caller's open transaction on `client`. See
 * `RunInteractions.signalWithStart`.
 */
export async function signalWithStartOnClient(
  client: PoolClient,
  codec: Codec,
  input: SignalWithStartInput,
): Promise<SignalWithStartReceipt> {
  if (input.workflowType.length === 0) {
    throw new RangeError("workflowType must not be empty");
  }
  if (input.workflowKey.length === 0) {
    throw new RangeError("workflowKey must not be empty");
  }
  const created = await insertRunOnClient(client, codec, {
    namespaceId: input.namespaceId,
    workflowType: input.workflowType,
    input: input.input ?? null,
    idempotencyKey: input.workflowKey,
    queueName: input.queueName ?? "default",
    taskReason: "signal_with_start",
  });
  let runId = created;
  if (runId === undefined) {
    const existing = await client.query<{ id: string; workflow_type: string }>(
      "select id, workflow_type from workflow_runs where namespace_id = $1 and idempotency_key = $2",
      [input.namespaceId, input.workflowKey],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new Error(`workflow key "${input.workflowKey}" was taken but no run holds it`);
    }
    if (row.workflow_type !== input.workflowType) {
      throw new WorkflowKeyConflictError(input.workflowKey, row.id, row.workflow_type);
    }
    runId = row.id;
  }
  const receipt = await signalRunOnClient(
    client,
    codec,
    runId,
    input.signalName,
    input.payload ?? null,
    { signalId: input.signalId },
  );
  return { ...receipt, created: created !== undefined };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    broken = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Creates `RunInteractions` over `pool`.
 */
export function createRunInteractions(
  pool: Pool,
  options: RunInteractionsOptions,
): RunInteractions {
  const codec = options.codec ?? jsonCodec;
  const store = createPostgresEventStore(pool, codec);

  return {
    async signalRun(
      runId: string,
      signalName: string,
      payload: unknown = null,
      signalOptions: SignalOptions = {},
    ): Promise<SignalReceipt> {
      return inTransaction(pool, (client) =>
        signalRunOnClient(client, codec, runId, signalName, payload, signalOptions),
      );
    },

    async signalWithStart(input: SignalWithStartInput): Promise<SignalWithStartReceipt> {
      return inTransaction(pool, (client) => signalWithStartOnClient(client, codec, input));
    },

    async queryRun(runId: string, queryName: string, argument?: unknown): Promise<unknown> {
      const events = await store.read(runId);
      const started = events[0]?.event;
      if (started?.type !== "run_started") {
        const known = await pool.query("select 1 from workflow_runs where id = $1", [runId]);
        throw known.rowCount === 1
          ? new RunHistoryCompactedError(runId)
          : new RunNotFoundError(runId);
      }
      const definition = options.workflows.get(started.workflowType);
      if (definition === undefined) {
        throw new WorkflowNotLoadedError(started.workflowType);
      }
      return runQuery(
        definition.handler,
        started.input,
        events.map((stored) => stored.event),
        { clock: options.clock, random: options.random },
        queryName,
        argument,
      );
    },

    async updateRun(
      runId: string,
      updateName: string,
      argument: unknown = null,
      callOptions: UpdateCallOptions = {},
    ): Promise<UpdateOutcome> {
      const client = await pool.connect();
      let broken = false;
      let receipt;
      try {
        await client.query("begin");
        receipt = await acceptUpdateOnClient(
          client,
          codec,
          { workflows: options.workflows, clock: options.clock },
          runId,
          updateName,
          argument,
          ...(callOptions.updateId === undefined ? [] : [callOptions.updateId]),
        );
        await client.query("commit");
      } catch (error) {
        broken = !(await rollbackQuietly(client));
        throw error;
      } finally {
        client.release(broken);
      }
      return awaitUpdateOutcome(
        pool,
        codec,
        runId,
        receipt,
        updateWaitMs(callOptions.waitMs),
        options.updateWait,
      );
    },
  };
}
