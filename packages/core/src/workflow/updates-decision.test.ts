import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.ts";
import { commandToEvent } from "./command-events.ts";
import { runDecisionLoop } from "./decision-loop.ts";
import { defineUpdate, UnknownUpdateError } from "./define-update.ts";
import { defineWorkflow } from "./define-workflow.ts";
import { runQuery } from "./query.ts";
import type { ClockSource, RandomSource } from "./sources.ts";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const cart = defineWorkflow("cart", async (ctx) => {
  const items: string[] = [];
  ctx.setQueryHandler("items", () => [...items]);
  ctx.setUpdateHandler(
    defineUpdate<string, number>("add", {
      validate: (item) => {
        if (items.includes(item)) {
          throw new Error(`"${item}" is in the cart already`);
        }
      },
      handler: (item) => {
        items.push(item);
        return items.length;
      },
    }),
  );
  ctx.setUpdateHandler(
    defineUpdate("break", {
      handler: () => {
        throw new Error("the cart refuses");
      },
    }),
  );
  ctx.setUpdateHandler(
    defineUpdate<number>("charge", {
      handler: (amount) => ctx.step("charge", { amount }),
    }),
  );
  await ctx.waitForSignal("checkout");
  return [...items];
});

const started: WorkflowEvent = { type: "run_started", workflowType: "cart", input: {} };

function accepted(updateId: string, updateName: string, argument: unknown): WorkflowEvent {
  return { type: "update_accepted", updateId, updateName, argument };
}

describe("updates in the decision loop", () => {
  it("runs the handler at the accepted position and records its result", async () => {
    const decision = await runDecisionLoop(
      cart.handler,
      {},
      [started, accepted("u-1", "add", "apple")],
      sources,
    );

    expect(decision).toEqual({
      outcome: "suspended",
      commands: [{ type: "complete_update", updateId: "u-1", result: 1 }],
    });
  });

  it("replays a completed update to the same state without new commands", async () => {
    const history: WorkflowEvent[] = [started, accepted("u-1", "add", "apple")];
    const first = await runDecisionLoop(cart.handler, {}, history, sources);
    const recorded = [...history, ...first.commands.map(commandToEvent)];

    const again = await runDecisionLoop(cart.handler, {}, recorded, sources);
    const twice = await runDecisionLoop(cart.handler, {}, recorded, sources);

    expect(again).toEqual({ outcome: "suspended", commands: [] });
    expect(twice).toEqual(again);
    expect(await runQuery(cart.handler, {}, recorded, sources, "items")).toEqual(["apple"]);
  });

  it("applies several updates in the order they were accepted", async () => {
    const history: WorkflowEvent[] = [
      started,
      accepted("u-1", "add", "apple"),
      accepted("u-2", "add", "pear"),
      accepted("u-3", "add", "plum"),
      { type: "signal_received", signalName: "checkout", payload: null },
    ];

    const decision = await runDecisionLoop(cart.handler, {}, history, sources);

    expect(decision.commands).toEqual([
      { type: "complete_update", updateId: "u-1", result: 1 },
      { type: "complete_update", updateId: "u-2", result: 2 },
      { type: "complete_update", updateId: "u-3", result: 3 },
      { type: "complete_run", result: ["apple", "pear", "plum"] },
    ]);
  });

  it("records what a throwing handler threw as the update's error", async () => {
    const decision = await runDecisionLoop(
      cart.handler,
      {},
      [started, accepted("u-1", "break", null)],
      sources,
    );

    expect(decision.outcome).toBe("suspended");
    expect(decision.commands).toEqual([
      {
        type: "complete_update",
        updateId: "u-1",
        result: null,
        error: expect.objectContaining({
          name: "Error",
          message: "the cart refuses",
        }) as unknown,
      },
    ]);
  });

  it("fails an update whose handler is not registered at its position", async () => {
    const decision = await runDecisionLoop(
      cart.handler,
      {},
      [started, accepted("u-1", "remove", "apple")],
      sources,
    );

    expect(decision.commands).toEqual([
      {
        type: "complete_update",
        updateId: "u-1",
        result: null,
        error: expect.objectContaining({
          name: "UnknownUpdateError",
          message: new UnknownUpdateError("remove").message,
        }) as unknown,
      },
    ]);
  });

  it("lets a handler schedule a step and completes it from the recorded result", async () => {
    const history: WorkflowEvent[] = [started, accepted("u-1", "charge", 40)];
    const first = await runDecisionLoop(cart.handler, {}, history, sources);
    expect(first.commands).toEqual([
      { type: "schedule_step", stepId: "step-1", stepType: "charge", input: { amount: 40 } },
    ]);

    const completed = await runDecisionLoop(
      cart.handler,
      {},
      [
        ...history,
        ...first.commands.map(commandToEvent),
        { type: "step_completed", stepId: "step-1", result: "receipt-40" },
      ],
      sources,
    );

    expect(completed.commands).toEqual([
      { type: "complete_update", updateId: "u-1", result: "receipt-40" },
    ]);
  });

  it("shows a query the state after every accepted update", async () => {
    const history: WorkflowEvent[] = [
      started,
      accepted("u-1", "add", "apple"),
      accepted("u-2", "add", "pear"),
    ];

    expect(await runQuery(cart.handler, {}, history, sources, "items")).toEqual(["apple", "pear"]);
  });

  it("refuses an empty update name", () => {
    expect(() => defineUpdate("", { handler: () => null })).toThrow("an update needs a name");
  });
});
