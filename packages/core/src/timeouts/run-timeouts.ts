import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.ts";
import { appendEventsOnClient, readCurrentSequenceOnClient } from "../event-store/event-store.ts";
import { closeRunIfTerminal } from "../cancellation/close-run.ts";
import { lockRunWithParent } from "../children/run-locks.ts";
import { isTerminalState, type RunState } from "../run/state-machine.ts";

/**
 * The id of the durable timer that ends a single run when its run timeout
 * passes. Workflow code never sees it: it is not a `timer-N` of the run.
 */
export const RUN_TIMEOUT_TIMER_ID = "run-timeout";

/**
 * The id of the durable timer that ends a run when the execution deadline of
 * its whole continue-as-new chain passes.
 */
export const EXECUTION_TIMEOUT_TIMER_ID = "execution-timeout";

/**
 * The limits a run is created with. `runTimeoutMs` bounds this run alone and
 * restarts with each run of a continue-as-new chain. `executionDeadline` is
 * an absolute instant for the whole chain, carried over to every run in it.
 */
export interface RunTimeoutLimits {
  readonly runTimeoutMs?: number | undefined;
  readonly executionDeadline?: Date | undefined;
}

/**
 * Checks a timeout the caller passed and returns it, or `undefined` when none
 * was asked for. Rejects with a `RangeError` unless it is a positive finite
 * number of milliseconds.
 */
export function validateTimeoutMs(name: string, value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds, got ${String(value)}`);
  }
  return Math.ceil(value);
}

/**
 * Turns the limits a run is created with into its columns and durable
 * timers, inside the caller's transaction, so a timeout exists exactly when
 * its run does. `startedAt` is the creation instant the run timeout counts
 * from; `executionTimeoutMs` becomes the chain deadline only for the first
 * run of a chain, a continued run passes the inherited `executionDeadline`.
 */
export async function applyRunTimeoutsOnClient(
  client: PoolClient,
  runId: string,
  startedAt: Date,
  limits: RunTimeoutLimits & { readonly executionTimeoutMs?: number | undefined },
): Promise<void> {
  const runTimeoutMs = validateTimeoutMs("runTimeoutMs", limits.runTimeoutMs);
  const executionTimeoutMs = validateTimeoutMs("executionTimeoutMs", limits.executionTimeoutMs);
  const executionDeadline =
    limits.executionDeadline ??
    (executionTimeoutMs === undefined
      ? undefined
      : new Date(startedAt.getTime() + executionTimeoutMs));
  if (runTimeoutMs === undefined && executionDeadline === undefined) {
    return;
  }
  await client.query(
    "update workflow_runs set run_timeout_ms = $2, execution_deadline = $3 where id = $1",
    [runId, runTimeoutMs ?? null, executionDeadline ?? null],
  );
  if (runTimeoutMs !== undefined) {
    await insertTimeoutTimer(
      client,
      runId,
      RUN_TIMEOUT_TIMER_ID,
      new Date(startedAt.getTime() + runTimeoutMs),
    );
  }
  if (executionDeadline !== undefined) {
    await insertTimeoutTimer(client, runId, EXECUTION_TIMEOUT_TIMER_ID, executionDeadline);
  }
}

async function insertTimeoutTimer(
  client: PoolClient,
  runId: string,
  timerId: string,
  fireAt: Date,
): Promise<void> {
  await client.query(
    `insert into timers (run_id, timer_id, fire_at) values ($1, $2, $3)
     on conflict (run_id, timer_id) do nothing`,
    [runId, timerId, fireAt],
  );
}

/**
 * Whether `timerId` belongs to the engine's timeout handling rather than to
 * workflow code.
 */
export function isTimeoutTimerId(timerId: string): boolean {
  return timerId === RUN_TIMEOUT_TIMER_ID || timerId === EXECUTION_TIMEOUT_TIMER_ID;
}

/**
 * Ends a run whose timeout timer came due: appends `run_timed_out` and
 * closes the run with `closeRunIfTerminal` in the caller's transaction, which
 * withdraws its waiting tasks and records the outcome in its parent's
 * history. Does nothing and resolves `false` when the run is missing or
 * already closed. Locks the run with its parent first.
 */
export async function timeOutRunOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
  timerId: string,
): Promise<boolean> {
  const locked = await lockRunWithParent(client, runId);
  if (locked === undefined || isTerminalState(locked.status as RunState)) {
    return false;
  }
  const currentSeq = await readCurrentSequenceOnClient(client, runId);
  await appendEventsOnClient(client, codec, runId, currentSeq, [
    {
      type: "run_timed_out",
      kind: timerId === EXECUTION_TIMEOUT_TIMER_ID ? "execution" : "run",
    },
  ]);
  await closeRunIfTerminal(client, codec, runId);
  return true;
}
