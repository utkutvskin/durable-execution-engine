import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import { lockRunWithParent, type LockedRun } from "../children/run-locks.ts";
import { appendEventsOnClient, readCurrentSequenceOnClient } from "../event-store/event-store.ts";
import { RunNotFoundError } from "../signals/signal-service.ts";
import { closeRunIfTerminal } from "./close-run.ts";
import { requestCancellationOnClient } from "./request-cancellation.ts";
import { rollbackQuietly } from "../db/transaction.ts";

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
 * Options for `createRunControl`. The `WORKFLOW_TASK` of a cancellation
 * request goes to the queue of the run it concerns.
 */
export interface RunControlOptions {
  readonly codec?: Codec;
}

/**
 * Requests graceful cancellation of `runId` inside the caller's open
 * transaction on `client`: takes the run row lock (its parent's first),
 * records `cancel_requested` and enqueues a workflow task, unless a request
 * is already pending. Rejects with `RunNotFoundError` or
 * `RunAlreadyClosedError`.
 */
export async function cancelRunOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
  reason?: string,
): Promise<CancelReceipt> {
  const row = await lockOpenRun(client, runId);
  return requestCancellationOnClient(
    client,
    codec,
    { runId, namespaceId: row.namespaceId, queueName: row.queueName },
    reason,
  );
}

async function lockOpenRun(client: PoolClient, runId: string): Promise<LockedRun> {
  const row = await lockRunWithParent(client, runId);
  if (row === undefined) {
    throw new RunNotFoundError(runId);
  }
  if (row.status !== "RUNNING") {
    throw new RunAlreadyClosedError(runId, row.status);
  }
  return row;
}

/**
 * Creates `RunControl` over `pool`.
 */
export function createRunControl(pool: Pool, options: RunControlOptions = {}): RunControl {
  const codec = options.codec ?? jsonCodec;

  async function inTransaction<TResult>(
    body: (client: PoolClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      const outcome = await body(client);
      await client.query("commit");
      return outcome;
    } catch (error) {
      broken = !(await rollbackQuietly(client));
      throw error;
    } finally {
      client.release(broken);
    }
  }

  return {
    cancelRun(runId: string, reason?: string): Promise<CancelReceipt> {
      return inTransaction((client) => cancelRunOnClient(client, codec, runId, reason));
    },

    terminateRun(runId: string, reason?: string): Promise<TerminateReceipt> {
      return inTransaction(async (client) => {
        await lockOpenRun(client, runId);
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
