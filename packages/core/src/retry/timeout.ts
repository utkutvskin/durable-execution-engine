import type { ClockSource } from "../workflow/sources.js";
import type { EventStore } from "../event-store/event-store.js";
import { isTerminalState } from "../run/state-machine.js";
import { foldRunEvents } from "../run/projection.js";

/**
 * The timer functions `runWithTimeout` schedules its deadline with.
 * Structurally the same as the worker's `Timers`.
 */
export interface TimeoutTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Thrown when a step outlives its `timeoutMs`. It is retryable like any
 * other failure.
 */
export class StepTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`step timed out after ${String(timeoutMs)} ms`);
    this.name = "StepTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runs `operation` and rejects with a `StepTimeoutError` if it has not
 * settled after `timeoutMs`. `operation` receives an `AbortSignal` that is
 * aborted at the deadline so a cooperative step can stop. The timer is
 * always cleared. Without `timeoutMs` the operation runs unbounded.
 */
export async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number | undefined,
  timers: TimeoutTimers,
): Promise<T> {
  const controller = new AbortController();
  if (timeoutMs === undefined) {
    return operation(controller.signal);
  }
  let handle: unknown;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = timers.setTimeout(() => {
      const error = new StepTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(operation(controller.signal)), deadline]);
  } finally {
    timers.clearTimeout(handle);
  }
}

/**
 * The instant a run that started at `startedAt` must be over by.
 */
export function workflowDeadline(startedAt: Date, timeoutMs: number): Date {
  return new Date(startedAt.getTime() + timeoutMs);
}

/**
 * What `enforceWorkflowTimeout` did: `timed_out` when it appended
 * `run_timed_out`, `within_deadline` when the run still has time, `closed`
 * when the run had already reached a terminal state.
 */
export type WorkflowTimeoutOutcome = "timed_out" | "within_deadline" | "closed";

/**
 * Appends `run_timed_out` to `runId` if `timeoutMs` has passed since its
 * first event and the run is not already terminal. A concurrent append that
 * wins the race makes this reject with the event store's `ConcurrencyError`.
 */
export async function enforceWorkflowTimeout(options: {
  readonly store: EventStore;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly clock: ClockSource;
}): Promise<WorkflowTimeoutOutcome> {
  const stored = await options.store.read(options.runId);
  const first = stored[0];
  if (first === undefined) {
    return "within_deadline";
  }
  const projection = foldRunEvents(stored);
  if (isTerminalState(projection.state)) {
    return "closed";
  }
  const deadline = workflowDeadline(first.createdAt, options.timeoutMs);
  if (options.clock.now().getTime() < deadline.getTime()) {
    return "within_deadline";
  }
  await options.store.append(options.runId, projection.lastSequenceNumber, [
    { type: "run_timed_out" },
  ]);
  return "timed_out";
}
