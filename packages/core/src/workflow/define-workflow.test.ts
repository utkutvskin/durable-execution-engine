import { describe, expect, it } from "vitest";
import { defineWorkflow } from "./define-workflow.js";

describe("defineWorkflow", () => {
  it("returns a definition carrying the workflow type and handler unchanged", () => {
    const handler = (): Promise<undefined> => Promise.resolve(undefined);

    const definition = defineWorkflow("noop", handler);

    expect(definition.workflowType).toBe("noop");
    expect(definition.handler).toBe(handler);
  });
});
