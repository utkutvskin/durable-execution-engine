import { describe, expect, it } from "vitest";
import { workflowEventSchema } from "./events.js";

describe("workflowEventSchema", () => {
  it("accepts a well-formed run_started event", () => {
    const result = workflowEventSchema.safeParse({
      type: "run_started",
      workflowType: "ship-order",
      input: { orderId: "123" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed step_completed event", () => {
    const result = workflowEventSchema.safeParse({
      type: "step_completed",
      stepId: "charge-card",
      result: { transactionId: "abc" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an event with a discriminant outside the closed set", () => {
    const result = workflowEventSchema.safeParse({
      type: "run_deleted",
      workflowType: "ship-order",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a run_started event missing its required workflowType field", () => {
    const result = workflowEventSchema.safeParse({
      type: "run_started",
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a step_failed event whose error is not an object", () => {
    const result = workflowEventSchema.safeParse({
      type: "step_failed",
      stepId: "charge-card",
      error: "boom",
    });
    expect(result.success).toBe(false);
  });

  it("accepts the run_timed_out, run_cancelled and run_terminated events", () => {
    for (const event of [
      { type: "run_timed_out" },
      { type: "run_cancelled", reason: "user request" },
      { type: "run_terminated" },
    ]) {
      expect(workflowEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("accepts a step_attempt_failed event with and without a retry time", () => {
    const base = {
      type: "step_attempt_failed",
      stepId: "s",
      attempt: 2,
      error: { name: "Error", message: "boom" },
    };
    expect(
      workflowEventSchema.safeParse({ ...base, retryAt: "2026-01-01T00:00:01.000Z" }).success,
    ).toBe(true);
    expect(workflowEventSchema.safeParse({ ...base, retryAt: null }).success).toBe(true);
  });

  it("rejects a step_attempt_failed event with attempt zero", () => {
    const result = workflowEventSchema.safeParse({
      type: "step_attempt_failed",
      stepId: "s",
      attempt: 0,
      error: { name: "Error", message: "boom" },
      retryAt: null,
    });
    expect(result.success).toBe(false);
  });
});
