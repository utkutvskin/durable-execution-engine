import type { Pool } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.js";
import {
  appendEventsOnClient,
  createPostgresEventStore,
  readCurrentSequenceOnClient,
} from "../event-store/event-store.js";
import type { ClockSource, RandomSource } from "../workflow/sources.js";
import { runQuery } from "../workflow/query.js";
import type { WorkflowRegistry } from "../workflow/workflow-registry.js";

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
 * What `signalRun` returns: the sequence number of the recorded
 * `signal_received` event.
 */
export interface SignalReceipt {
  readonly sequenceNumber: number;
}

/**
 * Sends signals to and reads queries from runs.
 */
export interface RunInteractions {
  /**
   * Records a `signal_received` event on `runId` and enqueues a workflow
   * task so the run reacts to it, in one transaction. The signal is kept in
   * the history whether or not the run is waiting yet. Rejects with
   * `RunNotFoundError` or `RunNotOpenError`.
   */
  signalRun(runId: string, signalName: string, payload?: unknown): Promise<SignalReceipt>;

  /**
   * Replays the run's history and answers the named query from the
   * workflow's state at its current point. Reads only: no event, task or
   * row is written. Rejects with `RunNotFoundError` or `UnknownQueryError`.
   */
  queryRun(runId: string, queryName: string, argument?: unknown): Promise<unknown>;
}

/**
 * Options for `createRunInteractions`. `queueName` is the queue the
 * `WORKFLOW_TASK` of a signal goes to. `clock` and `random` serve
 * `ctx.now()`, `ctx.random()` and `ctx.uuid()` while a query replays.
 */
export interface RunInteractionsOptions {
  readonly queueName: string;
  readonly workflows: WorkflowRegistry;
  readonly clock: ClockSource;
  readonly random: RandomSource;
  readonly codec?: Codec;
}

interface RunRow {
  namespace_id: string;
  workflow_type: string;
  status: string;
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
    ): Promise<SignalReceipt> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const run = await client.query<RunRow>(
          "select namespace_id, workflow_type, status from workflow_runs where id = $1 for update",
          [runId],
        );
        const row = run.rows[0];
        if (row === undefined) {
          throw new RunNotFoundError(runId);
        }
        if (row.status !== "RUNNING") {
          throw new RunNotOpenError(runId, row.status);
        }
        const currentSeq = await readCurrentSequenceOnClient(client, runId);
        const [stored] = await appendEventsOnClient(client, codec, runId, currentSeq, [
          { type: "signal_received", signalName, payload },
        ]);
        await client.query(
          `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
           values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
          [
            row.namespace_id,
            runId,
            options.queueName,
            JSON.stringify({ reason: "signal", signalName }),
          ],
        );
        await client.query("commit");
        return { sequenceNumber: stored?.sequenceNumber ?? currentSeq + 1 };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async queryRun(runId: string, queryName: string, argument?: unknown): Promise<unknown> {
      const events = await store.read(runId);
      const started = events[0]?.event;
      if (started?.type !== "run_started") {
        throw new RunNotFoundError(runId);
      }
      const definition = options.workflows.get(started.workflowType);
      if (definition === undefined) {
        throw new Error(`no workflow registered for type "${started.workflowType}"`);
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
  };
}
