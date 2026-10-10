import type { WorkflowCommand } from "../workflow/commands.js";
import { InvalidTransitionError } from "./errors.js";

/**
 * Every state a workflow run can be in.
 */
export const RUN_STATES = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "TERMINATED",
  "CONTINUED_AS_NEW",
] as const;

/**
 * A workflow run's state, as stored in `workflow_runs.status`.
 */
export type RunState = (typeof RUN_STATES)[number];

/**
 * The permitted transitions: a `RUNNING` run may move to any terminal
 * state, and a terminal state has no way out.
 */
export const RUN_STATE_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  RUNNING: ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED", "TERMINATED", "CONTINUED_AS_NEW"],
  COMPLETED: [],
  FAILED: [],
  TIMED_OUT: [],
  CANCELLED: [],
  TERMINATED: [],
  CONTINUED_AS_NEW: [],
};

/**
 * Whether `state` is one no further transition or command can leave.
 */
export function isTerminalState(state: RunState): boolean {
  return RUN_STATE_TRANSITIONS[state].length === 0;
}

/**
 * Throws `InvalidTransitionError` unless `RUN_STATE_TRANSITIONS` permits
 * moving from `from` to `to`.
 */
export function assertTransition(from: RunState, to: RunState): void {
  if (!RUN_STATE_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/**
 * Throws `InvalidTransitionError` when `command` is applied to a run in a
 * terminal state: a closed run accepts no new command of any kind.
 */
export function assertRunAcceptsCommand(state: RunState, command: WorkflowCommand): void {
  if (isTerminalState(state)) {
    throw new InvalidTransitionError(state, command.type);
  }
}
