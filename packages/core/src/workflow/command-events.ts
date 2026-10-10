import type { WorkflowEvent } from "../event-store/events.js";
import type { WorkflowCommand } from "./commands.js";

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
      return { type: "timer_started", timerId: command.timerId, fireAt: command.fireAt };
    case "start_child":
      return {
        type: "child_started",
        childId: command.childId,
        workflowType: command.workflowType,
        input: command.input,
        parentClosePolicy: command.parentClosePolicy,
      };
    case "complete_run":
      return { type: "run_completed", result: command.result };
    case "fail_run":
      return { type: "run_failed", error: command.error };
    case "continue_as_new":
      return { type: "run_continued_as_new", input: command.input };
    case "cancel_run":
      return command.reason === undefined
        ? { type: "run_cancelled" }
        : { type: "run_cancelled", reason: command.reason };
  }
}
