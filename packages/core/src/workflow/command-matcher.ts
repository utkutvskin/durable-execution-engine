import type { WorkflowEvent } from "../event-store/events.js";
import { sameEncoding } from "./canonical.js";
import { NonDeterminismError } from "./errors.js";

/**
 * A command as the replaying code issues it, or as the history recorded it:
 * the four kinds whose order a replay has to reproduce.
 */
export type CommandShape =
  | {
      readonly kind: "step";
      readonly id: string;
      readonly stepType: string;
      readonly input: unknown;
    }
  | { readonly kind: "timer"; readonly id: string; readonly durationMs?: number }
  | {
      readonly kind: "child";
      readonly id: string;
      readonly workflowType: string;
      readonly input: unknown;
    }
  | { readonly kind: "patch"; readonly id: string };

/**
 * The commands `event` records, as a `CommandShape`, or `undefined` for an
 * event that records no command.
 */
export function recordedCommandOf(event: WorkflowEvent): CommandShape | undefined {
  switch (event.type) {
    case "step_scheduled":
      return { kind: "step", id: event.stepId, stepType: event.stepType, input: event.input };
    case "timer_started":
      return event.durationMs === undefined
        ? { kind: "timer", id: event.timerId }
        : { kind: "timer", id: event.timerId, durationMs: event.durationMs };
    case "child_started":
      return {
        kind: "child",
        id: event.childId,
        workflowType: event.workflowType,
        input: event.input,
      };
    case "patch_recorded":
      return { kind: "patch", id: event.patchId };
    default:
      return undefined;
  }
}

function describe(shape: CommandShape): { readonly stepType: string; readonly input: unknown } {
  switch (shape.kind) {
    case "step":
      return { stepType: shape.stepType, input: shape.input };
    case "timer":
      return { stepType: "sleep", input: { durationMs: shape.durationMs } };
    case "child":
      return { stepType: `child:${shape.workflowType}`, input: shape.input };
    case "patch":
      return { stepType: "patch", input: { patchId: shape.id } };
  }
}

function sameCommand(recorded: CommandShape, issued: CommandShape): boolean {
  if (recorded.kind !== issued.kind || recorded.id !== issued.id) {
    return false;
  }
  switch (recorded.kind) {
    case "step":
      return (
        issued.kind === "step" &&
        recorded.stepType === issued.stepType &&
        sameEncoding(recorded.input, issued.input)
      );
    case "timer":
      return (
        issued.kind === "timer" &&
        (recorded.durationMs === undefined || recorded.durationMs === issued.durationMs)
      );
    case "child":
      return (
        issued.kind === "child" &&
        recorded.workflowType === issued.workflowType &&
        sameEncoding(recorded.input, issued.input)
      );
    case "patch":
      return true;
  }
}

/**
 * Compares the commands replaying code issues, in the order it issues them,
 * with the commands the history recorded, in the order it recorded them.
 */
export interface CommandMatcher {
  /** Adds the commands a newly read part of the history recorded. */
  record(shapes: readonly CommandShape[]): void;
  /**
   * Registers the next command the code issues. Returns `true` when the
   * history already holds it and `false` when it is new. Throws
   * `NonDeterminismError` when the history holds a different command at that
   * position.
   */
  issue(shape: CommandShape): boolean;
  /**
   * Throws `NonDeterminismError` when the history holds commands the code
   * has not issued.
   */
  assertAllIssued(): void;
}

/**
 * Creates a `CommandMatcher` that starts with no recorded commands.
 */
export function createCommandMatcher(): CommandMatcher {
  const recorded: CommandShape[] = [];
  let issued = 0;

  return {
    record(shapes) {
      recorded.push(...shapes);
    },
    issue(shape) {
      const position = issued;
      issued += 1;
      const expected = recorded[position];
      if (expected === undefined) {
        return false;
      }
      if (!sameCommand(expected, shape)) {
        const recordedSide = describe(expected);
        const issuedSide = describe(shape);
        throw new NonDeterminismError(shape.id, recordedSide, issuedSide);
      }
      return true;
    },
    assertAllIssued() {
      const missing = recorded[issued];
      if (missing !== undefined) {
        throw new NonDeterminismError(
          missing.id,
          describe(missing),
          { stepType: "nothing", input: undefined },
          `non-deterministic replay: history recorded ${missing.kind} "${missing.id}" ` +
            `at position ${String(issued + 1)}, but the workflow code did not issue it`,
        );
      }
    },
  };
}
