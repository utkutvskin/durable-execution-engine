import { describe, expect, it } from "vitest";
import { InvalidConcurrencyRuleError } from "../queue/concurrency-keys.ts";
import { defineStep } from "./define-step.ts";
import { defineWorkflow } from "./define-workflow.ts";

describe("defineWorkflow", () => {
  it("returns a definition carrying the workflow type and handler unchanged", () => {
    const handler = (): Promise<undefined> => Promise.resolve(undefined);

    const definition = defineWorkflow("noop", handler);

    expect(definition.workflowType).toBe("noop");
    expect(definition.handler).toBe(handler);
  });

  it("carries a concurrency rule on workflows and steps and refuses a bad limit", () => {
    const rule = { key: (input: { customer: string }) => input.customer, limit: 2 };

    const workflow = defineWorkflow("keyed", () => Promise.resolve(1), { concurrency: rule });
    const step = defineStep("keyed-step", { handler: () => 1, concurrency: rule });

    expect(workflow.concurrency).toBe(rule);
    expect(step.concurrency).toBe(rule);
    expect(defineWorkflow("plain", () => Promise.resolve(1))).not.toHaveProperty("concurrency");
    expect(() =>
      defineWorkflow("bad", () => Promise.resolve(1), {
        concurrency: { key: () => "k", limit: 0 },
      }),
    ).toThrow(InvalidConcurrencyRuleError);
    expect(() =>
      defineStep("bad-step", { handler: () => 1, concurrency: { key: () => "k", limit: -1 } }),
    ).toThrow(/step "bad-step" has a concurrency limit/);
  });
});
