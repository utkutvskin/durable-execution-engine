import type { WorkflowEvent } from "../event-store/events.ts";
import type { WorkflowCommand } from "./commands.ts";

/**
 * Turns a command a decision produced into the event that records it in the
 * run's history.
 */
export function commandToEvent(command: WorkflowCommand): WorkflowEvent {
  switch (command.type) {
    case "schedule_step":
      return {
        type: "step_scheduled",
        stepId: command.stepId,
        stepType: command.stepType,
        input: command.input,
      };
    case "start_timer":
      return {
        type: "timer_started",
        timerId: command.timerId,
        fireAt: command.fireAt,
        durationMs: command.durationMs,
      };
    case "start_child":
      return {
        type: "child_started",
        childId: command.childId,
        workflowType: command.workflowType,
        input: command.input,
        parentClosePolicy: command.parentClosePolicy,
        ...(command.runTimeoutMs === undefined ? {} : { runTimeoutMs: command.runTimeoutMs }),
        ...(command.executionTimeoutMs === undefined
          ? {}
          : { executionTimeoutMs: command.executionTimeoutMs }),
      };
    case "record_patch":
      return command.buildId === undefined
        ? { type: "patch_recorded", patchId: command.patchId }
        : { type: "patch_recorded", patchId: command.patchId, buildId: command.buildId };
    case "record_time":
      return { type: "time_recorded", time: command.time };
    case "record_compensation_failure":
      return { type: "compensation_failed", index: command.index, error: command.error };
    case "complete_update":
      return command.error === undefined
        ? { type: "update_completed", updateId: command.updateId, result: command.result }
        : {
            type: "update_completed",
            updateId: command.updateId,
            result: null,
            error: command.error,
          };
    case "complete_run":
      return { type: "run_completed", result: command.result };
    case "fail_run":
      return { type: "run_failed", error: command.error };
    case "continue_as_new":
      return command.signals === undefined || command.signals.length === 0
        ? { type: "run_continued_as_new", input: command.input }
        : {
            type: "run_continued_as_new",
            input: command.input,
            signals: command.signals.map((signal) => ({ ...signal })),
          };
    case "wait_for_event":
      return command.expiresAt === undefined
        ? {
            type: "event_wait_started",
            waitId: command.waitId,
            eventName: command.eventName,
            key: command.key,
          }
        : {
            type: "event_wait_started",
            waitId: command.waitId,
            eventName: command.eventName,
            key: command.key,
            expiresAt: command.expiresAt,
          };
    case "cancel_run":
      return command.reason === undefined
        ? { type: "run_cancelled" }
        : { type: "run_cancelled", reason: command.reason };
  }
}
