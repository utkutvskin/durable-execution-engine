import { describe, expect, it } from "vitest";
import { createWorkflowRegistry } from "./workflow-registry.js";

describe("createWorkflowRegistry", () => {
  it("returns the registered definition for its workflow type", () => {
    const registry = createWorkflowRegistry();
    const handler = (): Promise<undefined> => Promise.resolve(undefined);

    registry.register({ workflowType: "ship-order", handler });

    expect(registry.get("ship-order")).toEqual({ workflowType: "ship-order", handler });
  });

  it("returns undefined for a workflow type that was never registered", () => {
    const registry = createWorkflowRegistry();

    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("rejects registering the same workflow type twice", () => {
    const registry = createWorkflowRegistry();
    const handler = (): Promise<undefined> => Promise.resolve(undefined);
    registry.register({ workflowType: "ship-order", handler });

    expect(() => {
      registry.register({ workflowType: "ship-order", handler });
    }).toThrow('workflow type "ship-order" is already registered');
  });
});
