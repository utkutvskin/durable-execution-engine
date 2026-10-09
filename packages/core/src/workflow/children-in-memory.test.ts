import { describe, expect, it } from "vitest";
import { defineWorkflow } from "./define-workflow.js";
import { runWorkflowInMemory } from "./run-workflow.js";
import { createStepRegistry } from "./step-registry.js";
import { createWorkflowRegistry } from "./workflow-registry.js";

const sources = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const square = defineWorkflow("square", (_ctx, input: { value: number }) =>
  Promise.resolve(input.value ** 2),
);

function registryWith(...definitions: (typeof square)[]) {
  const workflows = createWorkflowRegistry();
  for (const definition of definitions) {
    workflows.register(definition);
  }
  return workflows;
}

describe("child workflows in the in-memory runner", () => {
  it("runs a child workflow from the registry and records its start command", async () => {
    const parent = defineWorkflow("parent", async (ctx) =>
      ctx.executeChild<number>("square", { value: 7 }),
    );

    const result = await runWorkflowInMemory(
      parent.handler,
      {},
      {
        ...sources,
        steps: createStepRegistry(),
        workflows: registryWith(square),
      },
    );

    expect(result).toMatchObject({ outcome: "completed", result: 49 });
    expect(result.commands[0]).toEqual({
      type: "start_child",
      childId: "child-1",
      workflowType: "square",
      input: { value: 7 },
      parentClosePolicy: "cancel",
    });
  });

  it("aggregates a fan-out of 100 children with ctx.all", async () => {
    const parent = defineWorkflow("parent", async (ctx) => {
      const squares = await ctx.all(
        Array.from(
          { length: 100 },
          (_, index) => () => ctx.executeChild<number>("square", { value: index + 1 }),
        ),
        { concurrency: 10 },
      );
      return squares.reduce((total, value) => total + value, 0);
    });

    const result = await runWorkflowInMemory(
      parent.handler,
      {},
      {
        ...sources,
        steps: createStepRegistry(),
        workflows: registryWith(square),
      },
    );

    expect(result).toMatchObject({ outcome: "completed", result: 338_350 });
  });

  it("fails the child's handle when no workflows are registered", async () => {
    const parent = defineWorkflow("parent", async (ctx) => {
      const [outcome] = await ctx.allSettled([() => ctx.executeChild("square", { value: 1 })]);
      return outcome?.status;
    });

    const result = await runWorkflowInMemory(
      parent.handler,
      {},
      {
        ...sources,
        steps: createStepRegistry(),
      },
    );

    expect(result).toMatchObject({ outcome: "completed", result: "rejected" });
  });

  it("fails the parent when a child it awaits fails", async () => {
    const broken = defineWorkflow("broken", () => Promise.reject(new Error("child exploded")));
    const parent = defineWorkflow("parent", async (ctx) => ctx.executeChild("broken", {}));

    const result = await runWorkflowInMemory(
      parent.handler,
      {},
      {
        ...sources,
        steps: createStepRegistry(),
        workflows: registryWith(broken as unknown as typeof square),
      },
    );

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.error.message).toBe("child exploded");
  });
});
