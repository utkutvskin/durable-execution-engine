import type { ParentClosePolicy, RecordedError } from "../event-store/events.ts";

/**
 * A step was scheduled for execution as part of a run's decision.
 */
export interface ScheduleStepCommand {
  readonly type: "schedule_step";
  readonly stepId: string;
  readonly stepType: string;
  readonly input: unknown;
}

/**
 * A durable timer was started, due to fire at `fireAt` (an ISO-8601 string)
 * after the `durationMs` the workflow asked for.
 */
export interface StartTimerCommand {
  readonly type: "start_timer";
  readonly timerId: string;
  readonly fireAt: string;
  readonly durationMs: number;
}

/**
 * A child workflow was started. `childId` is unique within the parent run.
 */
export interface StartChildCommand {
  readonly type: "start_child";
  readonly childId: string;
  readonly workflowType: string;
  readonly input: unknown;
  readonly parentClosePolicy: ParentClosePolicy;
  readonly runTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
}

/**
 * The run took the new code path for `patchId`. `buildId` is the worker
 * build that made the decision, when it declared one.
 */
export interface RecordPatchCommand {
  readonly type: "record_patch";
  readonly patchId: string;
  readonly buildId?: string;
}

/**
 * A `ctx.now()` call was answered with `time` (an ISO 8601 string), the time
 * of the event that triggered the decision.
 */
export interface RecordTimeCommand {
  readonly type: "record_time";
  readonly time: string;
}

/**
 * A compensation registered with `ctx.onCancel()` threw. `index` is its
 * position in registration order.
 */
export interface RecordCompensationFailureCommand {
  readonly type: "record_compensation_failure";
  readonly index: number;
  readonly error: RecordedError;
}

/**
 * The handler of the accepted update `updateId` finished, with `result` or
 * with `error` when it threw.
 */
export interface CompleteUpdateCommand {
  readonly type: "complete_update";
  readonly updateId: string;
  readonly result: unknown;
  readonly error?: RecordedError;
}

/**
 * The run finished successfully with the given result.
 */
export interface CompleteRunCommand {
  readonly type: "complete_run";
  readonly result: unknown;
}

/**
 * The run finished with the given error.
 */
export interface FailRunCommand {
  readonly type: "fail_run";
  readonly error: RecordedError;
}

/**
 * The run was cancelled: a cancellation was requested and every registered
 * compensation has finished.
 */
export interface CancelRunCommand {
  readonly type: "cancel_run";
  readonly reason?: string;
}

/**
 * The run hands over to a new run of the same workflow type that starts with
 * `input`, closing this one. `signals` are the unconsumed signals the new
 * run receives again.
 */
export interface ContinueAsNewCommand {
  readonly type: "continue_as_new";
  readonly input: unknown;
  readonly signals?: readonly CarriedSignal[];
}

/**
 * A signal a run received but did not consume before it continued as new,
 * carried over into the next run of the chain.
 */
export interface CarriedSignal {
  readonly signalName: string;
  readonly payload: unknown;
  readonly signalId?: string;
}

/**
 * The run started waiting for the external event `eventName` with the
 * correlation key `key`. `expiresAt` (an ISO-8601 string) is when the wait's
 * timeout fires, if it has one.
 */
export interface WaitForEventCommand {
  readonly type: "wait_for_event";
  readonly waitId: string;
  readonly eventName: string;
  readonly key: string;
  readonly expiresAt?: string;
}

/**
 * Every command kind a workflow decision can produce, discriminated on
 * `type`. A decision produces zero or more `ScheduleStepCommand`,
 * `StartTimerCommand`, `StartChildCommand`, `RecordPatchCommand`, `RecordTimeCommand`, `CompleteUpdateCommand` and `WaitForEventCommand` entries, followed by at most one of
 * `CompleteRunCommand`, `FailRunCommand`, `CancelRunCommand` or
 * `ContinueAsNewCommand`.
 */
export type WorkflowCommand =
  | ScheduleStepCommand
  | StartTimerCommand
  | StartChildCommand
  | RecordPatchCommand
  | RecordTimeCommand
  | RecordCompensationFailureCommand
  | CompleteUpdateCommand
  | WaitForEventCommand
  | CompleteRunCommand
  | FailRunCommand
  | CancelRunCommand
  | ContinueAsNewCommand;
