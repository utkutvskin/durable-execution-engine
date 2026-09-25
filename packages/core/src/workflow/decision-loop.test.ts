import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import type { WorkflowCommand } from "./commands.js";
import { runDecisionLoop } from "./decision-loop.js";
import { defineWorkflow } from "./define-workflow.js";
import { NonDeterminismError } from "./errors.js";
import { ForbiddenApiError } from "./sandbox.js";
import type { ClockSource, RandomSource } from "./sources.js";

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

const shipOrderInput: ShipOrderInput = { orderId: "order-1", amount: 42 };

const historyThroughFirstStep: readonly WorkflowEvent[] = [
  { type: "run_started", workflowType: "ship-order", input: shipOrderInput },
  { type: "step_scheduled", stepId: "step-1", stepType: "charge-card", input: { amount: 42 } },
  { type: "step_completed", stepId: "step-1", result: { charged: true } },
];

const historyThroughTimer: readonly WorkflowEvent[] = [
  ...historyThroughFirstStep,
  { type: "timer_started", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
  { type: "timer_fired", timerId: "timer-1" },
];

const historyThroughSecondStep: readonly WorkflowEvent[] = [
  ...historyThroughTimer,
  { type: "step_scheduled", stepId: "step-2", stepType: "reserve-inventory", input: { orderId: "order-1" } },
  { type: "step_completed", stepId: "step-2", result: { reserved: true, orderId: "order-1" } },
];

const historyThroughThirdStep: readonly WorkflowEvent[] = [
  ...historyThroughSecondStep,
  { type: "step_scheduled", stepId: "step-3", stepType: "ship-package", input: { orderId: "order-1" } },
  { type: "step_completed", stepId: "step-3", result: { orderId: "order-1", shipped: true } },
];

describe("runDecisionLoop", () => {
  it("stops at the first incomplete point and produces only that step's command from an empty history", async () => {
    const outcome = await runDecisionLoop(shipOrderWorkflow().handler, shipOrderInput, [], fixedSources());

    expect(outcome).toEqual({
      outcome: "suspended",
      commands: [
        { type: "schedule_step", stepId: "step-1", stepType: "charge-card", input: { amount: 42 } },
      ],
    });
  });

  it("given a partial history with 2 of 3 steps complete, produces only the third step's command", async () => {
    const outcome = await runDecisionLoop(
      shipOrderWorkflow().handler,
      shipOrderInput,
      historyThroughSecondStep,
      fixedSources(),
    );

    expect(outcome).toEqual({
      outcome: "suspended",
      commands: [{ type: "schedule_step", stepId: "step-3", stepType: "ship-package", input: { orderId: "order-1" } }],
    });
  });

  it("does not repeat a command for a step that is already scheduled but not yet complete", async () => {
    const inFlightHistory: readonly WorkflowEvent[] = [
      { type: "run_started", workflowType: "ship-order", input: shipOrderInput },
      { type: "step_scheduled", stepId: "step-1", stepType: "charge-card", input: { amount: 42 } },
    ];

    const outcome = await runDecisionLoop(
      shipOrderWorkflow().handler,
      shipOrderInput,
      inFlightHistory,
      fixedSources(),
    );

    expect(outcome).toEqual({ outcome: "suspended", commands: [] });
  });

  it("completes the run once every step and timer in the history is resolved", async () => {
    const outcome = await runDecisionLoop(
      shipOrderWorkflow().handler,
      shipOrderInput,
      historyThroughThirdStep,
      fixedSources(),
    );

    expect(outcome).toEqual({
      outcome: "completed",
      result: { orderId: "order-1", shipped: true },
      commands: [{ type: "complete_run", result: { orderId: "order-1", shipped: true } }],
    });
  });

  it("three consecutive replays over the same history produce an identical command sequence", async () => {
    const runs = await Promise.all(
      Array.from({ length: 3 }, () =>
        runDecisionLoop(shipOrderWorkflow().handler, shipOrderInput, historyThroughFirstStep, fixedSources()),
      ),
    );

    const expected: WorkflowCommand[] = [
      { type: "start_timer", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
    ];
    for (const outcome of runs) {
      expect(outcome).toEqual({ outcome: "suspended", commands: expected });
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[1]).toEqual(runs[2]);
  });

  it("reconstructs a failed step's error from the history and fails the run with it", async () => {
    const failedHistory: readonly WorkflowEvent[] = [
      { type: "run_started", workflowType: "ship-order", input: shipOrderInput },
      { type: "step_scheduled", stepId: "step-1", stepType: "charge-card", input: { amount: 42 } },
      { type: "step_failed", stepId: "step-1", error: { name: "CardDeclinedError", message: "card declined" } },
    ];

    const outcome = await runDecisionLoop(
      shipOrderWorkflow().handler,
      shipOrderInput,
      failedHistory,
      fixedSources(),
    );

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.error.name).toBe("CardDeclinedError");
      expect(outcome.error.message).toBe("card declined");
    }
    expect(outcome.commands).toEqual([
      { type: "fail_run", error: { name: "CardDeclinedError", message: "card declined" } },
    ]);
  });

  it("leaves nothing pending after it returns: no further command appears on a later tick", async () => {
    const commandsSeenAtReturn = (
      await runDecisionLoop(shipOrderWorkflow().handler, shipOrderInput, historyThroughFirstStep, fixedSources())
    ).commands;

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(commandsSeenAtReturn).toEqual([
      { type: "start_timer", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
    ]);
  });

  it("does not repeat a command for a timer that is already started but not yet fired", async () => {
    const timerInFlightHistory: readonly WorkflowEvent[] = [
      ...historyThroughFirstStep,
      { type: "timer_started", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
    ];

    const outcome = await runDecisionLoop(
      shipOrderWorkflow().handler,
      shipOrderInput,
      timerInFlightHistory,
      fixedSources(),
    );

    expect(outcome).toEqual({ outcome: "suspended", commands: [] });
  });

  it("throws NonDeterminismError when replayed code calls a different step type at the same stepId", async () => {
    const reorderedWorkflow = defineWorkflow<ShipOrderInput, ShipOrderResult>(
      "ship-order",
      async (ctx, input) => {
        await ctx.step("reserve-inventory", { amount: input.amount });
        return ctx.step<ShipOrderResult>("ship-package", { orderId: input.orderId });
      },
    );

    await expect(
      runDecisionLoop(reorderedWorkflow.handler, shipOrderInput, historyThroughFirstStep, fixedSources()),
    ).rejects.toThrow(NonDeterminismError);
  });

  it("reports the recorded and the replayed step type and input on a NonDeterminismError", async () => {
    const reorderedWorkflow = defineWorkflow<ShipOrderInput, ShipOrderResult>(
      "ship-order",
      async (ctx, input) => {
        await ctx.step("reserve-inventory", { amount: input.amount });
        return ctx.step<ShipOrderResult>("ship-package", { orderId: input.orderId });
      },
    );

    const failure: unknown = await runDecisionLoop(
      reorderedWorkflow.handler,
      shipOrderInput,
      historyThroughFirstStep,
      fixedSources(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NonDeterminismError);
    if (failure instanceof NonDeterminismError) {
      expect(failure.stepId).toBe("step-1");
      expect(failure.expected).toEqual({ stepType: "charge-card", input: { amount: 42 } });
      expect(failure.found).toEqual({ stepType: "reserve-inventory", input: { amount: 42 } });
    }
  });

  it("throws NonDeterminismError when the same step type is called with different input", async () => {
    const differentInputWorkflow = defineWorkflow<ShipOrderInput, ShipOrderResult>(
      "ship-order",
      async (ctx, input) => {
        await ctx.step("charge-card", { amount: input.amount + 1 });
        await ctx.sleep(60_000);
        await ctx.step("reserve-inventory", { orderId: input.orderId });
        return ctx.step<ShipOrderResult>("ship-package", { orderId: input.orderId });
      },
    );

    await expect(
      runDecisionLoop(differentInputWorkflow.handler, shipOrderInput, historyThroughFirstStep, fixedSources()),
    ).rejects.toThrow(NonDeterminismError);
  });

  it("does not throw NonDeterminismError when the same step type and input are replayed", async () => {
    const outcome = await runDecisionLoop(
      shipOrderWorkflow().handler,
      shipOrderInput,
      historyThroughFirstStep,
      fixedSources(),
    );

    expect(outcome.outcome).toBe("suspended");
  });

  it("rejects with ForbiddenApiError when a workflow calls Date.now() directly", async () => {
    const forbiddenClockWorkflow = defineWorkflow<ShipOrderInput, ShipOrderResult>(
      "ship-order",
      async (_ctx, input) => {
        await Promise.resolve();
        Date.now();
        return { orderId: input.orderId, shipped: true };
      },
    );

    await expect(
      runDecisionLoop(forbiddenClockWorkflow.handler, shipOrderInput, [], fixedSources()),
    ).rejects.toThrow(ForbiddenApiError);
  });

  it("rejects with ForbiddenApiError when a workflow calls Math.random() directly", async () => {
    const forbiddenRandomWorkflow = defineWorkflow<ShipOrderInput, ShipOrderResult>(
      "ship-order",
      async (_ctx, input) => {
        await Promise.resolve();
        Math.random();
        return { orderId: input.orderId, shipped: true };
      },
    );

    await expect(
      runDecisionLoop(forbiddenRandomWorkflow.handler, shipOrderInput, [], fixedSources()),
    ).rejects.toThrow(ForbiddenApiError);
  });

  it("rejects with ForbiddenApiError when a workflow calls setTimeout() directly", async () => {
    const forbiddenTimerWorkflow = defineWorkflow<ShipOrderInput, ShipOrderResult>(
      "ship-order",
      async (_ctx, input) => {
        await Promise.resolve();
        setTimeout(() => undefined, 0);
        return { orderId: input.orderId, shipped: true };
      },
    );

    await expect(
      runDecisionLoop(forbiddenTimerWorkflow.handler, shipOrderInput, [], fixedSources()),
    ).rejects.toThrow(ForbiddenApiError);
  });

  it("restores Date.now, Math.random and setTimeout once the decision returns, even after a forbidden call", async () => {
    const forbiddenClockWorkflow = defineWorkflow<ShipOrderInput, ShipOrderResult>(
      "ship-order",
      async (_ctx, input) => {
        await Promise.resolve();
        Date.now();
        return { orderId: input.orderId, shipped: true };
      },
    );

    await runDecisionLoop(forbiddenClockWorkflow.handler, shipOrderInput, [], fixedSources()).catch(
      () => undefined,
    );

    expect(typeof Date.now()).toBe("number");
    expect(typeof Math.random()).toBe("number");
    expect(() => {
      clearTimeout(setTimeout(() => undefined, 0));
    }).not.toThrow();
  });
});
