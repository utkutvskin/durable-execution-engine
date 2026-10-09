import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.js";
import { lockRunWithParent, type LockedRun } from "../children/run-locks.js";
import { appendEventsOnClient, readCurrentSequenceOnClient } from "../event-store/event-store.js";
import { RunNotFoundError } from "../signals/signal-service.js";
import { closeRunIfTerminal } from "./close-run.js";
import { requestCancellationOnClient } from "./request-cancellation.js";

/**
 * Raised when a run that already reached a terminal state is cancelled or
 * terminated.
 */
export class RunAlreadyClosedError extends Error {
  readonly runId: string;
  readonly status: string;

  constructor(runId: string, status: string) {
    super(`workflow run "${runId}" is already ${status}`);
    this.name = "RunAlreadyClosedError";
    this.runId = runId;
    this.status = status;
  }
}

/**
 * What `cancelRun` returns. `requested` is false when the run already had a
 * cancellation request, in which case nothing was written.
 */
export interface CancelReceipt {
  readonly requested: boolean;
  readonly sequenceNumber: number;
}

/**
 * What `terminateRun` returns: the sequence number of `run_terminated`.
 */
export interface TerminateReceipt {
  readonly sequenceNumber: number;
}

/**
 * Stops runs, gracefully or at once.
 */
export interface RunControl {
  /**
   * Requests graceful cancellation: records `cancel_requested` and enqueues
   * a workflow task, in one transaction. The run stays `RUNNING` while its
   * running step finishes and its compensations run; the workflow task that
   * finishes them records `run_cancelled`. Asking again while a request is
   * pending writes nothing. Rejects with `RunNotFoundError` or
   * `RunAlreadyClosedError`.
   */
  cancelRun(runId: string, reason?: string): Promise<CancelReceipt>;

  /**
   * Closes the run as `TERMINATED` immediately: records `run_terminated`,
   * updates the projection and withdraws the run's waiting tasks, in one
   * transaction. No compensation runs and a step that is still running has
   * its result discarded. Allowed on a run whose cancellation is pending.
   * Rejects with `RunNotFoundError` or `RunAlreadyClosedError`.
   */
  terminateRun(runId: string, reason?: string): Promise<TerminateReceipt>;
}

/**
 * Options for `createRunControl`. `queueName` is the queue the
 * `WORKFLOW_TASK` of a cancellation request goes to.
 */
export interface RunControlOptions {
  readonly queueName: string;
  readonly codec?: Codec;
}

/**
 * Creates `RunControl` over `pool`.
 */
export function createRunControl(pool: Pool, options: RunControlOptions): RunControl {
  const codec = options.codec ?? jsonCodec;

  async function inTransaction<TResult>(
    runId: string,
    body: (row: LockedRun, client: PoolClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = await lockRunWithParent(client, runId);
      if (row === undefined) {
        throw new RunNotFoundError(runId);
      }
      if (row.status !== "RUNNING") {
        throw new RunAlreadyClosedError(runId, row.status);
      }
      const outcome = await body(row, client);
      await client.query("commit");
      return outcome;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    cancelRun(runId: string, reason?: string): Promise<CancelReceipt> {
      return inTransaction(runId, async (row, client) => {
        return requestCancellationOnClient(
          client,
          codec,
          { runId, namespaceId: row.namespaceId, queueName: options.queueName },
          reason,
        );
      });
    },

    terminateRun(runId: string, reason?: string): Promise<TerminateReceipt> {
      return inTransaction(runId, async (_row, client) => {
        const currentSeq = await readCurrentSequenceOnClient(client, runId);
        const [stored] = await appendEventsOnClient(client, codec, runId, currentSeq, [
          reason === undefined ? { type: "run_terminated" } : { type: "run_terminated", reason },
        ]);
        await closeRunIfTerminal(client, codec, runId);
        return { sequenceNumber: stored?.sequenceNumber ?? currentSeq + 1 };
      });
    },
  };
}
