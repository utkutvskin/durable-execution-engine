import type { WorkflowEvent } from "../event-store/events.js";
import type { StoredEvent } from "../event-store/event-store.js";
import { InvalidTransitionError } from "./errors.js";
import { assertTransition, isTerminalState, type RunState } from "./state-machine.js";

/**
 * The read model of one run, derived purely from its event log.
 */
export interface RunProjection {
  readonly state: RunState;
  readonly input: unknown;
  readonly result: unknown;
  readonly error: { readonly name: string; readonly message: string } | null;
  readonly closedAt: Date | null;
  readonly lastSequenceNumber: number;
}

/**
 * The projection of a run that has no events yet.
 */
export function createInitialProjection(): RunProjection {
  return {
    state: "RUNNING",
    input: {},
    result: null,
    error: null,
    closedAt: null,
    lastSequenceNumber: 0,
  };
}

function terminalStateFor(event: WorkflowEvent): RunState | undefined {
  switch (event.type) {
    case "run_completed":
      return "COMPLETED";
    case "run_failed":
      return "FAILED";
    case "run_timed_out":
      return "TIMED_OUT";
    case "run_cancelled":
      return "CANCELLED";
    case "run_terminated":
      return "TERMINATED";
    case "run_continued_as_new":
      return "CONTINUED_AS_NEW";
    default:
      return undefined;
  }
}

/**
 * Applies one stored event to `projection` and returns the next projection.
 * Sequence numbers must arrive consecutively, and any event on a run that
 * is already terminal is rejected with `InvalidTransitionError`.
 */
export function applyEventToProjection(
  projection: RunProjection,
  stored: StoredEvent,
): RunProjection {
  if (stored.sequenceNumber !== projection.lastSequenceNumber + 1) {
    throw new Error(
      `event sequence gap: expected ${String(projection.lastSequenceNumber + 1)}, ` +
        `got ${String(stored.sequenceNumber)}`,
    );
  }
  const { event } = stored;
  if (isTerminalState(projection.state)) {
    throw new InvalidTransitionError(projection.state, event.type);
  }

  const advanced: RunProjection = { ...projection, lastSequenceNumber: stored.sequenceNumber };
  const target = terminalStateFor(event);
  if (target !== undefined) {
    assertTransition(projection.state, target);
    const closed = { ...advanced, state: target, closedAt: stored.createdAt };
    if (event.type === "run_completed") {
      return { ...closed, result: event.result ?? null };
    }
    if (event.type === "run_failed") {
      return { ...closed, error: event.error };
    }
    return closed;
  }
  if (event.type === "run_started") {
    return { ...advanced, input: event.input ?? {} };
  }
  return advanced;
}

/**
 * Folds `events`, in order, onto `from` (the initial projection by
 * default).
 */
export function foldRunEvents(
  events: readonly StoredEvent[],
  from: RunProjection = createInitialProjection(),
): RunProjection {
  return events.reduce(applyEventToProjection, from);
}
