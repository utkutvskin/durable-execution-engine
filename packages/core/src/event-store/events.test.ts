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
});
