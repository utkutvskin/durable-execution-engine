import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import type { Pool, PoolClient } from "pg";
import type { Codec } from "../event-store/codec.ts";
import type { RecordedError, WorkflowEvent } from "../event-store/events.ts";
import { appendEventsOnClient, readEventsOnClient } from "../event-store/event-store.ts";
import { replayHistory, throwOnVersionMismatch } from "../workflow/decision-loop.ts";
import { UnknownUpdateError, UpdateRejectedError } from "../workflow/define-update.ts";
import { guardAgainstForbiddenApis } from "../workflow/sandbox.ts";
import type { ClockSource } from "../workflow/sources.ts";
import type { WorkflowRegistry } from "../workflow/workflow-registry.ts";
import { RunHistoryCompactedError, RunNotFoundError, RunNotOpenError } from "./signal-service.ts";

/**
 * Raised when a run's workflow type is not in the registry of the process
 * asked to validate an update or answer a query, so its code cannot be
 * replayed here.
 */
export class WorkflowNotLoadedError extends Error {
  readonly workflowType: string;

  constructor(workflowType: string) {
    super(
      `workflow type "${workflowType}" is not loaded in this process: start it with the module that defines the workflow`,
    );
    this.name = "WorkflowNotLoadedError";
    this.workflowType = workflowType;
  }
}

/**
 * How long `updateRun` waits for an accepted update to complete when the
 * caller does not say.
 */
export const DEFAULT_UPDATE_WAIT_MS = 10_000;

/**
 * The longest wait `updateRun` accepts.
 */
export const MAX_UPDATE_WAIT_MS = 60_000;

/**
 * Options of one update call. `updateId` makes the call idempotent: a
 * second call with the same id on the same run accepts nothing new and
 * waits for the first one's result. `waitMs` bounds the wait for the
 * result (default `DEFAULT_UPDATE_WAIT_MS`, at most `MAX_UPDATE_WAIT_MS`).
 */
export interface UpdateCallOptions {
  readonly updateId?: string;
  readonly waitMs?: number;
}

/**
 * What an update call reports: `completed` with the handler's result,
 * `failed` with what the handler threw, or `accepted` when the wait ended
 * before the handler finished. The update stays accepted in every case.
 */
export type UpdateOutcome =
  | {
      readonly status: "completed";
      readonly updateId: string;
      readonly sequenceNumber: number;
      readonly result: unknown;
    }
  | {
      readonly status: "failed";
      readonly updateId: string;
      readonly sequenceNumber: number;
      readonly error: RecordedError;
    }
  | { readonly status: "accepted"; readonly updateId: string; readonly sequenceNumber: number };

/**
 * Where an accepted update was recorded. `duplicate` is true when the
 * `updateId` had been accepted before and nothing new was written.
 */
export interface UpdateReceipt {
  readonly updateId: string;
  readonly sequenceNumber: number;
  readonly duplicate: boolean;
}

/**
 * What accepting an update needs: the workflow code to replay and the
 * clock that serves `ctx.now()` during that replay.
 */
export interface UpdateAcceptOptions {
  readonly workflows: WorkflowRegistry;
  readonly clock: ClockSource;
}

/**
 * The clock and timer `awaitUpdateOutcome` waits with. They default to
 * `node:perf_hooks` and `node:timers`, which workflow decisions never patch.
 */
export interface UpdateWaitOptions {
  readonly pollMs?: number;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface RunRow {
  namespace_id: string;
  status: string;
  queue_name: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function startedEventOf(
  runId: string,
  events: readonly WorkflowEvent[],
): Extract<WorkflowEvent, { type: "run_started" }> {
  const started = events[0];
  if (started?.type !== "run_started") {
    throw new RunHistoryCompactedError(runId);
  }
  return started;
}

/**
 * Validates an update against the state of `runId` at its current point
 * and records it, inside the caller's open transaction on `client`. The run
 * row lock is taken first and held to the end of the transaction, so
 * concurrent updates are validated and recorded one at a time, each against
 * the state the ones before it left: the order of their `update_accepted`
 * events is the order their handlers run in. A validator that throws
 * rejects with `UpdateRejectedError` and writes nothing; so do
 * `RunNotFoundError`, `RunNotOpenError`, `RunHistoryCompactedError`,
 * `WorkflowNotLoadedError` and `UnknownUpdateError`.
 */
export async function acceptUpdateOnClient(
  client: PoolClient,
  codec: Codec,
  options: UpdateAcceptOptions,
  runId: string,
  updateName: string,
  argument: unknown,
  updateId: string = randomUUID(),
): Promise<UpdateReceipt> {
  const run = await client.query<RunRow>(
    "select namespace_id, status, queue_name from workflow_runs where id = $1 for update",
    [runId],
  );
  const row = run.rows[0];
  if (row === undefined) {
    throw new RunNotFoundError(runId);
  }
  const stored = await readEventsOnClient(client, codec, runId);
  const previous = stored.find(
    (entry) => entry.event.type === "update_accepted" && entry.event.updateId === updateId,
  );
  if (previous !== undefined) {
    return { updateId, sequenceNumber: previous.sequenceNumber, duplicate: true };
  }
  if (row.status !== "RUNNING") {
    throw new RunNotOpenError(runId, row.status);
  }
  const history = stored.map((entry) => entry.event);
  const started = startedEventOf(runId, history);
  const definition = options.workflows.get(started.workflowType);
  if (definition === undefined) {
    throw new WorkflowNotLoadedError(started.workflowType);
  }
  const triggeredAt = stored.at(-1)?.createdAt;
  const replayOptions = {
    clock: options.clock,
    runId,
    ...(triggeredAt === undefined ? {} : { triggeredAt }),
  };
  const replayed = await replayHistory(definition.handler, started.input, history, replayOptions);
  throwOnVersionMismatch(history, replayed.unconsultedPatches, replayOptions);
  const update = replayed.updateHandlers.get(updateName);
  if (update === undefined) {
    throw new UnknownUpdateError(updateName);
  }
  const validate = update.validate;
  if (validate !== undefined) {
    try {
      await guardAgainstForbiddenApis(() => {
        validate(argument);
        return Promise.resolve();
      });
    } catch (reason: unknown) {
      throw new UpdateRejectedError(updateName, reason);
    }
  }
  const currentSeq = stored.at(-1)?.sequenceNumber ?? 0;
  const [recorded] = await appendEventsOnClient(client, codec, runId, currentSeq, [
    { type: "update_accepted", updateId, updateName, argument: argument ?? null },
  ]);
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [row.namespace_id, runId, row.queue_name, JSON.stringify({ reason: "update", updateName })],
  );
  return { updateId, sequenceNumber: recorded?.sequenceNumber ?? currentSeq + 1, duplicate: false };
}

/**
 * Reads the outcome of the accepted update `receipt` names, polling the
 * history every `pollMs` (default 50) until `update_completed` is recorded
 * or `waitMs` has passed. A run that closed without completing the update
 * ends the wait at once with `accepted`.
 */
export async function awaitUpdateOutcome(
  pool: Pool,
  codec: Codec,
  runId: string,
  receipt: { readonly updateId: string; readonly sequenceNumber: number },
  waitMs: number,
  wait: UpdateWaitOptions = {},
): Promise<UpdateOutcome> {
  const nowMs = wait.nowMs ?? (() => performance.now());
  const sleep = wait.sleep ?? defaultSleep;
  const pollMs = wait.pollMs ?? 50;
  const deadline = nowMs() + waitMs;
  const recorded = { updateId: receipt.updateId, sequenceNumber: receipt.sequenceNumber };
  const accepted: UpdateOutcome = { status: "accepted", ...recorded };
  for (;;) {
    const client = await pool.connect();
    let found: WorkflowEvent | undefined;
    let closed = false;
    try {
      const events = await readEventsOnClient(client, codec, runId, receipt.sequenceNumber);
      found = events.find(
        (entry) =>
          entry.event.type === "update_completed" && entry.event.updateId === receipt.updateId,
      )?.event;
      if (found === undefined) {
        const status = await client.query<{ status: string }>(
          "select status from workflow_runs where id = $1",
          [runId],
        );
        closed = status.rows[0]?.status !== "RUNNING";
      }
    } finally {
      client.release();
    }
    if (found?.type === "update_completed") {
      return found.error === undefined
        ? { status: "completed", ...recorded, result: found.result }
        : { status: "failed", ...recorded, error: found.error };
    }
    const remaining = deadline - nowMs();
    if (closed || remaining <= 0) {
      return accepted;
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Clamps a requested wait to `[0, MAX_UPDATE_WAIT_MS]`, using
 * `DEFAULT_UPDATE_WAIT_MS` when none was requested.
 */
export function updateWaitMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_UPDATE_WAIT_MS;
  }
  return Math.min(Math.max(requested, 0), MAX_UPDATE_WAIT_MS);
}
