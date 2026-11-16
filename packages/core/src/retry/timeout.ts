import type { ClockSource } from "../workflow/sources.ts";
import type { EventStore } from "../event-store/event-store.ts";
import { isTerminalState } from "../run/state-machine.ts";
import { foldRunEvents } from "../run/projection.ts";

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
 * Thrown when a step that has a heartbeat timeout went that long without
 * calling `heartbeat()`. It is retryable like any other failure, and the
 * next attempt receives the details of the last heartbeat.
 */
export class StepHeartbeatTimeoutError extends Error {
  readonly heartbeatTimeoutMs: number;

  constructor(heartbeatTimeoutMs: number) {
    super(`step sent no heartbeat for ${String(heartbeatTimeoutMs)} ms`);
    this.name = "StepHeartbeatTimeoutError";
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }
}

/**
 * One deadline of `runWithDeadlines`: after `delayMs` the operation is
 * aborted and rejected with `error()`.
 */
export interface Deadline {
  readonly delayMs: number;
  error(): Error;
}

/**
 * The deadlines `runWithDeadlines` enforces. `fixed` deadlines run from the
 * start of the operation. `heartbeat` starts again every time the operation
 * calls its `heartbeat` callback.
 */
export interface Deadlines {
  readonly fixed: readonly Deadline[];
  readonly heartbeat?: Deadline;
}

/**
 * Runs `operation` and rejects with the error of the first deadline that
 * passes before it settles, aborting the `AbortSignal` it receives with the
 * same error. `operation` receives a `heartbeat` callback that restarts the
 * heartbeat deadline and does nothing once the operation is over. Every
 * timer is cleared when the operation settles.
 */
export async function runWithDeadlines<T>(
  operation: (signal: AbortSignal, heartbeat: () => void) => T | Promise<T>,
  deadlines: Deadlines,
  timers: TimeoutTimers,
): Promise<T> {
  const controller = new AbortController();
  const handles: unknown[] = [];
  let heartbeatHandle: unknown;
  let settled = false;
  let fail: (error: Error) => void = () => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    fail = (error: Error): void => {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      reject(error);
    };
  });
  expired.catch(() => undefined);
  const arm = (deadline: Deadline): unknown =>
    timers.setTimeout(() => {
      fail(deadline.error());
    }, deadline.delayMs);
  for (const deadline of deadlines.fixed) {
    handles.push(arm(deadline));
  }
  const heartbeatDeadline = deadlines.heartbeat;
  if (heartbeatDeadline !== undefined) {
    heartbeatHandle = arm(heartbeatDeadline);
  }
  const heartbeat = (): void => {
    if (settled || heartbeatDeadline === undefined || controller.signal.aborted) {
      return;
    }
    timers.clearTimeout(heartbeatHandle);
    heartbeatHandle = arm(heartbeatDeadline);
  };
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal, heartbeat)),
      expired,
    ]);
  } finally {
    settled = true;
    for (const handle of handles) {
      timers.clearTimeout(handle);
    }
    if (heartbeatDeadline !== undefined) {
      timers.clearTimeout(heartbeatHandle);
    }
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
