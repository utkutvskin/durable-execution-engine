import { describe, expect, it } from "vitest";
import type { WorkflowCommand } from "../workflow/commands.js";
import { InvalidTransitionError } from "./errors.js";
import {
  assertRunAcceptsCommand,
  assertTransition,
  isTerminalState,
  RUN_STATES,
  RUN_STATE_TRANSITIONS,
} from "./state-machine.js";

const scheduleStep: WorkflowCommand = {
  type: "schedule_step",
  stepId: "step-1",
  stepType: "charge-card",
  input: {},
};

describe("run state machine", () => {
  it("lets a RUNNING run move to every terminal state", () => {
    for (const target of RUN_STATES.filter((state) => state !== "RUNNING")) {
      expect(() => {
        assertTransition("RUNNING", target);
      }).not.toThrow();
    }
  });

  it("rejects every transition out of every terminal state", () => {
    const terminalStates = RUN_STATES.filter(isTerminalState);
    expect(terminalStates).toHaveLength(5);
    for (const from of terminalStates) {
      for (const to of RUN_STATES) {
        expect(() => {
          assertTransition(from, to);
        }).toThrow(InvalidTransitionError);
      }
    }
  });

  it("rejects a RUNNING to RUNNING transition", () => {
    expect(() => {
      assertTransition("RUNNING", "RUNNING");
    }).toThrow(InvalidTransitionError);
  });

  it("declares a transition entry for every state", () => {
    expect(Object.keys(RUN_STATE_TRANSITIONS).sort()).toEqual([...RUN_STATES].sort());
  });

  it("accepts a command on a RUNNING run", () => {
    expect(() => {
      assertRunAcceptsCommand("RUNNING", scheduleStep);
    }).not.toThrow();
  });

  it("rejects any command on a run in a terminal state, naming the state and the command", () => {
    for (const state of RUN_STATES.filter(isTerminalState)) {
      expect(() => {
        assertRunAcceptsCommand(state, scheduleStep);
      }).toThrow(
        expect.objectContaining({
          name: "InvalidTransitionError",
          from: state,
          attempted: "schedule_step",
        }) as Error,
      );
    }
  });
});
