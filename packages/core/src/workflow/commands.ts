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
 * A durable timer was started, due to fire at `fireAt` (an ISO-8601 string).
 */
export interface StartTimerCommand {
  readonly type: "start_timer";
  readonly timerId: string;
  readonly fireAt: string;
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
 * Every command kind a workflow decision can produce, discriminated on
 * `type`. A decision produces zero or more `ScheduleStepCommand` and
 * `StartTimerCommand` entries, followed by exactly one of
 * `CompleteRunCommand` or `FailRunCommand`.
 */
export type WorkflowCommand =
  | ScheduleStepCommand
  | StartTimerCommand
  | CompleteRunCommand
  | FailRunCommand;
