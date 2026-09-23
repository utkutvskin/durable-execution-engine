import { describe, expect, it } from "vitest";
import { createStepRegistry } from "./step-registry.js";

describe("createStepRegistry", () => {
  it("returns the registered handler for its step type", () => {
    const registry = createStepRegistry();
    const handler = (input: { amount: number }): { charged: boolean } => ({ charged: input.amount > 0 });

    registry.register("charge-card", handler);

    expect(registry.get("charge-card")).toBe(handler);
  });

  it("returns undefined for a step type that was never registered", () => {
    const registry = createStepRegistry();

    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("rejects registering the same step type twice", () => {
    const registry = createStepRegistry();
    registry.register("charge-card", () => ({ charged: true }));

    expect(() => {
      registry.register("charge-card", () => ({ charged: true }));
    }).toThrow('step type "charge-card" is already registered');
  });
});
