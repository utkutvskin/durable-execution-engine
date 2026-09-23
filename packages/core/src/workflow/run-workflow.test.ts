import { describe, expect, it, vi } from "vitest";
import type { WorkflowCommand } from "./commands.js";
import { defineWorkflow } from "./define-workflow.js";
import { createStepRegistry } from "./step-registry.js";
import type { ClockSource, RandomSource } from "./sources.js";
import { systemClock, systemRandomSource } from "./sources.js";
import { createWorkflowRegistry } from "./workflow-registry.js";
import { runRegisteredWorkflowInMemory, runWorkflowInMemory } from "./run-workflow.js";

interface ShipOrderInput {
  readonly orderId: string;
  readonly amount: number;
}

interface ShipOrderResult {
  readonly orderId: string;
  readonly shipped: boolean;
}

function shipOrderWorkflow() {
  return defineWorkflow<ShipOrderInput, ShipOrderResult>("ship-order", async (ctx, input) => {
    await ctx.step("charge-card", { amount: input.amount });
    await ctx.sleep(60_000);
    await ctx.step("reserve-inventory", { orderId: input.orderId });
    return ctx.step<ShipOrderResult>("ship-package", { orderId: input.orderId });
  });
}

function fixedSources(): { clock: ClockSource; random: RandomSource } {
  return {
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    random: { random: () => 0.5, uuid: () => "fixed-uuid" },
  };
}

describe("runWorkflowInMemory", () => {
  it("runs a three-step example workflow in memory and produces the correct command sequence", async () => {
    const steps = createStepRegistry();
    steps.register("charge-card", (input: { amount: number }) => ({ charged: input.amount > 0 }));
    steps.register("reserve-inventory", (input: { orderId: string }) => ({
      reserved: true,
      orderId: input.orderId,
    }));
    steps.register(
      "ship-package",
      (input: { orderId: string }): ShipOrderResult => ({ orderId: input.orderId, shipped: true }),
    );

    const outcome = await runWorkflowInMemory(
      shipOrderWorkflow().handler,
      { orderId: "order-1", amount: 42 },
      { ...fixedSources(), steps },
    );

    const expectedCommands: WorkflowCommand[] = [
      { type: "schedule_step", stepId: "step-1", stepType: "charge-card", input: { amount: 42 } },
      { type: "start_timer", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
      {
        type: "schedule_step",
        stepId: "step-2",
        stepType: "reserve-inventory",
        input: { orderId: "order-1" },
      },
      { type: "schedule_step", stepId: "step-3", stepType: "ship-package", input: { orderId: "order-1" } },
      { type: "complete_run", result: { orderId: "order-1", shipped: true } },
    ];

    expect(outcome).toEqual({
      outcome: "completed",
      result: { orderId: "order-1", shipped: true },
      commands: expectedCommands,
    });
  });

  it("reads ctx.now() and ctx.random() from the injected sources, never from Date.now() or Math.random()", async () => {
    const dateNowSpy = vi.spyOn(Date, "now");
    const mathRandomSpy = vi.spyOn(Math, "random");
    const fixedNow = new Date("2030-05-05T00:00:00.000Z");

    let observedNow: Date | undefined;
    let observedRandom: number | undefined;
    let observedUuid: string | undefined;

    const workflow = defineWorkflow<undefined, undefined>("read-sources", (ctx) => {
      observedNow = ctx.now();
      observedRandom = ctx.random();
      observedUuid = ctx.uuid();
      return Promise.resolve(undefined);
    });

    await runWorkflowInMemory(workflow.handler, undefined, {
      clock: { now: () => fixedNow },
      random: { random: () => 0.123456, uuid: () => "fixed-uuid-value" },
      steps: createStepRegistry(),
    });

    expect(observedNow).toBe(fixedNow);
    expect(observedRandom).toBe(0.123456);
    expect(observedUuid).toBe("fixed-uuid-value");
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(mathRandomSpy).not.toHaveBeenCalled();

    dateNowSpy.mockRestore();
    mathRandomSpy.mockRestore();
  });

  it("produces a fail_run command and no complete_run command when the handler throws", async () => {
    const workflow = defineWorkflow<undefined, undefined>("always-fails", (): Promise<undefined> => {
      throw new Error("card declined");
    });

    const outcome = await runWorkflowInMemory(workflow.handler, undefined, {
      ...fixedSources(),
      steps: createStepRegistry(),
    });

    expect(outcome).toEqual({
      outcome: "failed",
      error: new Error("card declined"),
      commands: [{ type: "fail_run", error: { name: "Error", message: "card declined" } }],
    });
  });

  it("fails the run when ctx.step references a step type that was never registered", async () => {
    const workflow = defineWorkflow<undefined, undefined>("missing-step", async (ctx) => {
      return ctx.step("does-not-exist", undefined);
    });

    const outcome = await runWorkflowInMemory(workflow.handler, undefined, {
      ...fixedSources(),
      steps: createStepRegistry(),
    });

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.error.message).toContain('no step registered for type "does-not-exist"');
    }
    expect(outcome.commands).toEqual([
      { type: "schedule_step", stepId: "step-1", stepType: "does-not-exist", input: undefined },
      {
        type: "fail_run",
        error: { name: "Error", message: 'no step registered for type "does-not-exist"' },
      },
    ]);
  });
});

describe("runRegisteredWorkflowInMemory", () => {
  it("looks the workflow up by type in the registry and runs it", async () => {
    const workflows = createWorkflowRegistry();
    workflows.register(shipOrderWorkflow());
    const steps = createStepRegistry();
    steps.register("charge-card", (input: { amount: number }) => ({ charged: input.amount > 0 }));
    steps.register("reserve-inventory", (input: { orderId: string }) => ({
      reserved: true,
      orderId: input.orderId,
    }));
    steps.register(
      "ship-package",
      (input: { orderId: string }): ShipOrderResult => ({ orderId: input.orderId, shipped: true }),
    );

    const outcome = await runRegisteredWorkflowInMemory<ShipOrderResult>(
      "ship-order",
      { orderId: "order-2", amount: 10 },
      { ...fixedSources(), steps, workflows },
    );

    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome === "completed") {
      expect(outcome.result).toEqual({ orderId: "order-2", shipped: true });
    }
  });

  it("rejects directly, with no command produced, for an unregistered workflow type", async () => {
    await expect(
      runRegisteredWorkflowInMemory("does-not-exist", undefined, {
        clock: systemClock,
        random: systemRandomSource,
        steps: createStepRegistry(),
        workflows: createWorkflowRegistry(),
      }),
    ).rejects.toThrow('no workflow registered for type "does-not-exist"');
  });
});
