import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import type { StoredEvent } from "../event-store/event-store.js";
import { InvalidTransitionError } from "./errors.js";
import { createInitialProjection, foldRunEvents } from "./projection.js";

function stored(events: readonly WorkflowEvent[]): StoredEvent[] {
  return events.map((event, index) => ({
    sequenceNumber: index + 1,
    event,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
  }));
}

describe("foldRunEvents", () => {
  it("starts a run in RUNNING with the recorded input", () => {
    const projection = foldRunEvents(
      stored([{ type: "run_started", workflowType: "ship-order", input: { orderId: 7 } }]),
    );
    expect(projection.state).toBe("RUNNING");
    expect(projection.input).toEqual({ orderId: 7 });
    expect(projection.lastSequenceNumber).toBe(1);
    expect(projection.closedAt).toBeNull();
  });

  it("moves to COMPLETED and records the result and close time", () => {
    const projection = foldRunEvents(
      stored([
        { type: "run_started", workflowType: "ship-order", input: {} },
        { type: "run_completed", result: { shipped: true } },
      ]),
    );
    expect(projection.state).toBe("COMPLETED");
    expect(projection.result).toEqual({ shipped: true });
    expect(projection.closedAt).toEqual(new Date(Date.UTC(2026, 0, 1, 0, 0, 1)));
  });

  it("moves to FAILED and records the error", () => {
    const projection = foldRunEvents(
      stored([
        { type: "run_started", workflowType: "ship-order", input: {} },
        { type: "run_failed", error: { name: "Error", message: "card declined" } },
      ]),
    );
    expect(projection.state).toBe("FAILED");
    expect(projection.error).toEqual({ name: "Error", message: "card declined" });
  });

  it("maps timed out, cancelled and terminated events to their states", () => {
    const finalState = (event: WorkflowEvent): string =>
      foldRunEvents(stored([{ type: "run_started", workflowType: "ship-order", input: {} }, event]))
        .state;
    expect(finalState({ type: "run_timed_out" })).toBe("TIMED_OUT");
    expect(finalState({ type: "run_cancelled", reason: "user" })).toBe("CANCELLED");
    expect(finalState({ type: "run_terminated" })).toBe("TERMINATED");
  });

  it("rejects any event applied after a terminal event", () => {
    const history = stored([
      { type: "run_started", workflowType: "ship-order", input: {} },
      { type: "run_completed", result: 1 },
      { type: "step_scheduled", stepId: "step-1", stepType: "charge-card", input: {} },
    ]);
    expect(() => foldRunEvents(history)).toThrow(InvalidTransitionError);
  });

  it("rejects a second terminal event with the state it was already in", () => {
    const history = stored([
      { type: "run_started", workflowType: "ship-order", input: {} },
      { type: "run_cancelled" },
      { type: "run_failed", error: { name: "Error", message: "late" } },
    ]);
    expect(() => foldRunEvents(history)).toThrow(
      expect.objectContaining({ from: "CANCELLED", attempted: "run_failed" }) as Error,
    );
  });

  it("rejects a gap in sequence numbers", () => {
    const [first] = stored([{ type: "run_started", workflowType: "ship-order", input: {} }]);
    if (first === undefined) {
      throw new Error("fixture missing");
    }
    expect(() =>
      foldRunEvents([{ ...first, sequenceNumber: 3 }], createInitialProjection()),
    ).toThrow(/sequence gap/);
  });

  it("does not mutate the projection it folds onto", () => {
    const initial = createInitialProjection();
    foldRunEvents(stored([{ type: "run_cancelled" }]), initial);
    expect(initial).toEqual(createInitialProjection());
  });
});
