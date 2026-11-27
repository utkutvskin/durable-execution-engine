import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../event-store/event-store.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { InvalidResetPointError, resetPointCandidates, resolveResetPoint } from "./reset-run.ts";

function history(events: readonly WorkflowEvent[]): StoredEvent[] {
  return events.map((event, index) => ({
    sequenceNumber: index + 1,
    event,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    version: 1,
  }));
}

const failedRun = history([
  { type: "run_started", workflowType: "order", input: {} },
  { type: "step_scheduled", stepId: "step-1", stepType: "reserve", input: {} },
  { type: "step_completed", stepId: "step-1", result: "reserved" },
  { type: "step_scheduled", stepId: "step-2", stepType: "charge", input: {} },
  {
    type: "step_failed",
    stepId: "step-2",
    error: { name: "Error", message: "bug" },
  },
  { type: "run_failed", error: { name: "Error", message: "bug" } },
]);

describe("reset points", () => {
  it("cuts before the step that failed for good", () => {
    expect(resolveResetPoint("run", failedRun, { kind: "failed-step" })).toBe(3);
  });

  it("cuts before the nth scheduled step, counted from 1", () => {
    expect(resolveResetPoint("run", failedRun, { kind: "step", step: 1 })).toBe(1);
    expect(resolveResetPoint("run", failedRun, { kind: "step", step: 2 })).toBe(3);
  });

  it("rejects a step number or an event the history does not have", () => {
    expect(() => resolveResetPoint("run", failedRun, { kind: "step", step: 3 })).toThrow(
      InvalidResetPointError,
    );
    expect(() => resolveResetPoint("run", failedRun, { kind: "step", step: 0 })).toThrow(
      /step 0 is not between 1 and 2/,
    );
    expect(() => resolveResetPoint("run", failedRun, { kind: "event", sequence: 7 })).toThrow(
      /event 7 is not between 1 and 6/,
    );
    expect(() => resolveResetPoint("run", failedRun, { kind: "event", sequence: 1.5 })).toThrow(
      InvalidResetPointError,
    );
  });

  it("rejects a failed-step cut on a run without a failed step", () => {
    const clean = history([{ type: "run_started", workflowType: "order", input: {} }]);
    expect(() => resolveResetPoint("run", clean, { kind: "failed-step" })).toThrow(
      /no step of the run failed for good/,
    );
  });

  it("offers every cut before the closing event, with the step a step_scheduled cut keeps", () => {
    expect(resetPointCandidates(failedRun)).toEqual([
      { sequence: 1, eventType: "run_started" },
      { sequence: 2, eventType: "step_scheduled", stepId: "step-1", stepType: "reserve", step: 1 },
      { sequence: 3, eventType: "step_completed" },
      { sequence: 4, eventType: "step_scheduled", stepId: "step-2", stepType: "charge", step: 2 },
      { sequence: 5, eventType: "step_failed" },
    ]);
  });

  it("offers no cut while a timer, a child or an update is unfinished, nor after a cancel request", () => {
    const busy = history([
      { type: "run_started", workflowType: "order", input: {} },
      { type: "timer_started", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
      { type: "timer_fired", timerId: "timer-1" },
      {
        type: "child_started",
        childId: "child-1",
        workflowType: "sub",
        input: {},
        parentClosePolicy: "terminate",
      },
      { type: "child_completed", childId: "child-1", result: null },
      { type: "update_accepted", updateId: "u-1", updateName: "rename", argument: "x" },
      { type: "update_completed", updateId: "u-1", result: null },
      { type: "event_wait_started", waitId: "wait-1", eventName: "paid", key: "o-1" },
      {
        type: "event_received",
        waitId: "wait-1",
        eventId: "e-1",
        eventName: "paid",
        key: "o-1",
        payload: 1,
      },
      { type: "cancel_requested" },
    ]);
    expect(resetPointCandidates(busy).map((candidate) => candidate.sequence)).toEqual([
      1, 3, 5, 7, 9,
    ]);
  });

  it("offers nothing for a history that does not start with run_started", () => {
    const compacted = history([
      { type: "step_scheduled", stepId: "step-9", stepType: "reserve", input: {} },
    ]);
    expect(resetPointCandidates(compacted)).toEqual([]);
  });
});
