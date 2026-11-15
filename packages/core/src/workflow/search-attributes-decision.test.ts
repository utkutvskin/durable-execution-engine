import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.ts";
import { InvalidSearchAttributesError } from "../visibility/search-attributes.ts";
import { commandToEvent } from "./command-events.ts";
import { runDecisionLoop } from "./decision-loop.ts";
import { defineWorkflow } from "./define-workflow.ts";
import { NonDeterminismError } from "./errors.ts";
import { runWorkflowInMemory } from "./run-workflow.ts";
import type { ClockSource, RandomSource } from "./sources.ts";
import { createStepRegistry } from "./step-registry.ts";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const order = defineWorkflow("order", async (ctx, input: { readonly customerId: string }) => {
  ctx.upsertSearchAttributes({ customerId: input.customerId, stage: "charging" });
  const charged = await ctx.step<number>("charge", {});
  ctx.upsertSearchAttributes({ stage: "charged", amount: charged, flagged: null });
  return charged;
});

const started: WorkflowEvent = {
  type: "run_started",
  workflowType: "order",
  input: { customerId: "c-1" },
};

async function recordedHistory(): Promise<WorkflowEvent[]> {
  const history: WorkflowEvent[] = [started];
  for (;;) {
    const decision = await runDecisionLoop(order.handler, { customerId: "c-1" }, history, sources);
    history.push(...decision.commands.map(commandToEvent));
    if (decision.outcome !== "suspended") {
      return history;
    }
    const step = history.find((event) => event.type === "step_scheduled");
    if (step?.type === "step_scheduled") {
      history.push({ type: "step_completed", stepId: step.stepId, result: 42 });
    }
  }
}

describe("search attributes in the decision loop", () => {
  it("records each upsert as a search_attributes_upserted event at the point it was made", async () => {
    const history = await recordedHistory();
    expect(history.map((event) => event.type)).toEqual([
      "run_started",
      "search_attributes_upserted",
      "step_scheduled",
      "step_completed",
      "search_attributes_upserted",
      "run_completed",
    ]);
    expect(history[1]).toEqual({
      type: "search_attributes_upserted",
      searchAttributes: { customerId: "c-1", stage: "charging" },
    });
    expect(history[4]).toEqual({
      type: "search_attributes_upserted",
      searchAttributes: { stage: "charged", amount: 42, flagged: null },
    });
  });

  it("replays a recorded history without issuing the upserts again", async () => {
    const history = await recordedHistory();
    const open = history.slice(0, -1);
    const first = await runDecisionLoop(order.handler, { customerId: "c-1" }, open, sources);
    const second = await runDecisionLoop(order.handler, { customerId: "c-1" }, open, sources);
    expect(first.commands).toEqual([{ type: "complete_run", result: 42 }]);
    expect(second).toEqual(first);
  });

  it("fails the replay with NonDeterminismError when the code now upserts other values", async () => {
    const history = await recordedHistory();
    const changed = defineWorkflow("order", async (ctx) => {
      ctx.upsertSearchAttributes({ customerId: "c-2", stage: "charging" });
      return ctx.step<number>("charge", {});
    });
    await expect(
      runDecisionLoop(changed.handler, { customerId: "c-1" }, history.slice(0, 4), sources),
    ).rejects.toThrow(NonDeterminismError);
  });

  it("keeps the upserts of a decision that continues as new, ahead of the continuation", async () => {
    const chained = defineWorkflow("chained", async (ctx, input: { readonly round: number }) => {
      ctx.upsertSearchAttributes({ round: input.round });
      return ctx.continueAsNew({ round: input.round + 1 });
    });
    const decision = await runDecisionLoop(
      chained.handler,
      { round: 1 },
      [{ type: "run_started", workflowType: "chained", input: { round: 1 } }],
      sources,
    );
    expect(decision.outcome).toBe("continued_as_new");
    expect(decision.commands).toEqual([
      { type: "upsert_search_attributes", searchAttributes: { round: 1 } },
      { type: "continue_as_new", input: { round: 2 } },
    ]);
  });

  it("throws InvalidSearchAttributesError into the workflow past the attribute limit", async () => {
    const greedy = defineWorkflow("greedy", (ctx) => {
      const attributes: Record<string, number> = {};
      for (let index = 0; index < 33; index += 1) {
        attributes[`a${String(index)}`] = index;
      }
      try {
        ctx.upsertSearchAttributes(attributes);
        return Promise.resolve("accepted");
      } catch (error) {
        return Promise.resolve(error instanceof InvalidSearchAttributesError ? "refused" : "other");
      }
    });
    const decision = await runDecisionLoop(
      greedy.handler,
      {},
      [{ type: "run_started", workflowType: "greedy", input: {} }],
      sources,
    );
    expect(decision.commands).toEqual([{ type: "complete_run", result: "refused" }]);
  });

  it("counts the attributes the run started with toward the limit", async () => {
    const adder = defineWorkflow("adder", async (ctx) => {
      await ctx.sleep(1);
      ctx.upsertSearchAttributes({ extra: true });
      return "accepted";
    });
    const initial: Record<string, number> = {};
    for (let index = 0; index < 32; index += 1) {
      initial[`a${String(index)}`] = index;
    }
    const decision = await runDecisionLoop(
      adder.handler,
      {},
      [
        { type: "run_started", workflowType: "adder", input: {}, searchAttributes: initial },
        {
          type: "timer_started",
          timerId: "timer-1",
          fireAt: "2026-01-01T00:00:00.001Z",
          durationMs: 1,
        },
        { type: "timer_fired", timerId: "timer-1" },
      ],
      sources,
    );
    expect(decision.outcome).toBe("failed");
    expect(decision.outcome === "failed" ? decision.error : undefined).toBeInstanceOf(
      InvalidSearchAttributesError,
    );
  });

  it("records upserts in the in-memory runner too", async () => {
    const steps = createStepRegistry();
    steps.register("charge", () => 7);
    const result = await runWorkflowInMemory(
      order.handler,
      { customerId: "c-9" },
      {
        ...sources,
        steps,
      },
    );
    expect(
      result.commands.filter((command) => command.type === "upsert_search_attributes"),
    ).toEqual([
      {
        type: "upsert_search_attributes",
        searchAttributes: { customerId: "c-9", stage: "charging" },
      },
      {
        type: "upsert_search_attributes",
        searchAttributes: { stage: "charged", amount: 7, flagged: null },
      },
    ]);
  });
});
