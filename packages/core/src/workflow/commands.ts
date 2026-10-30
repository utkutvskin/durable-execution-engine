import type { ParentClosePolicy } from "../event-store/events.js";

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
  readonly error: { name: string; message: string };
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
 * `input`, closing this one.
 */
export interface ContinueAsNewCommand {
  readonly type: "continue_as_new";
  readonly input: unknown;
}

/**
 * Every command kind a workflow decision can produce, discriminated on
 * `type`. A decision produces zero or more `ScheduleStepCommand`,
 * `StartTimerCommand`, `StartChildCommand`, `RecordPatchCommand` and `RecordTimeCommand` entries, followed by at most one of
 * `CompleteRunCommand`, `FailRunCommand`, `CancelRunCommand` or
 * `ContinueAsNewCommand`.
 */
export type WorkflowCommand =
  | ScheduleStepCommand
  | StartTimerCommand
  | StartChildCommand
  | RecordPatchCommand
  | RecordTimeCommand
  | CompleteRunCommand
  | FailRunCommand
  | CancelRunCommand
  | ContinueAsNewCommand;
