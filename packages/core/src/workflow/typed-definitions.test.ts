import { describe, expect, expectTypeOf, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.ts";
import type { ChildHandle, WorkflowContext } from "./context.ts";
import { runDecisionLoop } from "./decision-loop.ts";
import { defineQuery, defineSignal } from "./define-signal.ts";
import { defineStep } from "./define-step.ts";
import { defineUpdate } from "./define-update.ts";
import { defineWorkflow } from "./define-workflow.ts";
import { createLiveSession } from "./live-session.ts";
import { runQuery } from "./query.ts";
import { runWorkflowInMemory } from "./run-workflow.ts";
import { createStepRegistry } from "./step-registry.ts";

const sources = {
  clock: { now: () => new Date("2026-05-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

interface ChargeInput {
  readonly orderId: string;
  readonly cents: number;
}

interface Receipt {
  readonly receiptId: string;
  readonly cents: number;
}

const chargeCard = defineStep<ChargeInput, Receipt>("charge-card", {
  handler: (input) => ({ receiptId: `r-${input.orderId}`, cents: input.cents }),
});
const approved = defineSignal<{ readonly by: string }>("approved");
const status = defineQuery<undefined, string>("status");
const statusFor = defineQuery<{ readonly verbose: boolean }, string>("status-for");
const ship = defineWorkflow<{ readonly receiptId: string }, { readonly trackingId: string }>(
  "ship",
  (_ctx, input) => Promise.resolve({ trackingId: `t-${input.receiptId}` }),
);

const typedOrder = defineWorkflow<{ readonly orderId: string }, string>(
  "order",
  async (ctx, input) => {
    let state = "charging";
    ctx.setQueryHandler(status, () => state);
    ctx.setQueryHandler(statusFor, (argument) => (argument.verbose ? `order is ${state}` : state));
    const receipt = await ctx.step(chargeCard, { orderId: input.orderId, cents: 1200 });
    expectTypeOf(receipt).toEqualTypeOf<Receipt>();
    state = "waiting";
    const approval = await ctx.waitForSignal(approved);
    expectTypeOf(approval).toEqualTypeOf<{ readonly by: string }>();
    const shipped = await ctx.executeChild(ship, { receiptId: receipt.receiptId });
    expectTypeOf(shipped).toEqualTypeOf<{ readonly trackingId: string }>();
    state = "shipped";
    return `${receipt.receiptId} approved by ${approval.by}, ${shipped.trackingId}`;
  },
);

const stringOrder = defineWorkflow<{ readonly orderId: string }, string>(
  "order",
  async (ctx, input) => {
    let state = "charging";
    ctx.setQueryHandler("status", () => state);
    ctx.setQueryHandler("status-for", (argument) =>
      (argument as { verbose: boolean }).verbose ? `order is ${state}` : state,
    );
    const receipt = await ctx.step<Receipt>("charge-card", {
      orderId: input.orderId,
      cents: 1200,
    });
    state = "waiting";
    const approval = await ctx.waitForSignal<{ by: string }>("approved");
    const shipped = await ctx.executeChild<{ trackingId: string }>("ship", {
      receiptId: receipt.receiptId,
    });
    state = "shipped";
    return `${receipt.receiptId} approved by ${approval.by}, ${shipped.trackingId}`;
  },
);

const history: WorkflowEvent[] = [
  { type: "run_started", workflowType: "order", input: { orderId: "o-1" } },
  {
    type: "step_scheduled",
    stepId: "step-1",
    stepType: "charge-card",
    input: { orderId: "o-1", cents: 1200 },
  },
  { type: "step_completed", stepId: "step-1", result: { receiptId: "r-o-1", cents: 1200 } },
  { type: "signal_received", signalName: "approved", payload: { by: "ada" } },
  {
    type: "child_started",
    childId: "child-1",
    workflowType: "ship",
    input: { receiptId: "r-o-1" },
    parentClosePolicy: "cancel",
  },
  { type: "child_completed", childId: "child-1", result: { trackingId: "t-r-o-1" } },
];

function compileTimeChecks(ctx: WorkflowContext): void {
  // @ts-expect-error cents must be a number, the definition says so
  void ctx.step(chargeCard, { orderId: "o-1", cents: "1200" });
  // @ts-expect-error the input misses orderId
  void ctx.step(chargeCard, { cents: 1200 });
  // @ts-expect-error the child's input is a receipt id, not an order id
  void ctx.executeChild(ship, { orderId: "o-1" });
  // @ts-expect-error a status query takes no argument object
  ctx.setQueryHandler(statusFor, (argument: string) => argument);
  // @ts-expect-error the status query answers with a string
  ctx.setQueryHandler(status, () => 42);
  void ctx.step("charge-card", { anything: true });
}

describe("typed workflow definitions", () => {
  it("rejects a wrong input type at compile time and types every result", () => {
    expectTypeOf(chargeCard.handler).parameter(0).toEqualTypeOf<ChargeInput>();
    expectTypeOf<WorkflowContext["step"]>().toBeFunction();
    expectTypeOf((ctx: WorkflowContext) =>
      ctx.step(chargeCard, { orderId: "o", cents: 1 }),
    ).returns.resolves.toEqualTypeOf<Receipt>();
    expectTypeOf((ctx: WorkflowContext) =>
      ctx.startChild(ship, { receiptId: "r" }),
    ).returns.toEqualTypeOf<ChildHandle<{ readonly trackingId: string }>>();
    expectTypeOf((ctx: WorkflowContext) =>
      ctx.step<number>("legacy", {}),
    ).returns.resolves.toEqualTypeOf<number>();
    expect(compileTimeChecks).toBeTypeOf("function");
  });

  it("records the same history whether a step, signal and child are named by definition or by string", async () => {
    for (let length = 1; length <= history.length; length += 1) {
      const prefix = history.slice(0, length);
      const typed = await runDecisionLoop(typedOrder.handler, { orderId: "o-1" }, prefix, sources);
      const named = await runDecisionLoop(stringOrder.handler, { orderId: "o-1" }, prefix, sources);
      expect(typed).toEqual(named);
    }
    const done = await runDecisionLoop(typedOrder.handler, { orderId: "o-1" }, history, sources);
    expect(done.outcome === "completed" && done.result).toBe("r-o-1 approved by ada, t-r-o-1");
  });

  it("answers a query registered through its definition by name", async () => {
    const waiting = history.slice(0, 3);
    expect(await runQuery(typedOrder.handler, { orderId: "o-1" }, waiting, sources, "status")).toBe(
      "waiting",
    );
    expect(
      await runQuery(typedOrder.handler, { orderId: "o-1" }, history, sources, "status-for", {
        verbose: true,
      }),
    ).toBe("order is shipped");
  });

  it("drives the live session through the typed calls", async () => {
    const approval = defineWorkflow<{ readonly orderId: string }, string>(
      "approval",
      async (ctx, input) => {
        const receipt = await ctx.step(chargeCard, { orderId: input.orderId, cents: 1200 });
        const by = await ctx.waitForSignal(approved);
        return `${receipt.receiptId} approved by ${by.by}`;
      },
    );
    const session = createLiveSession(approval.handler, { orderId: "o-1" }, sources);
    const advance = await session.advance(history.slice(0, 4));

    expect(advance.status === "decided" && advance.decision.commands).toEqual([
      { type: "complete_run", result: "r-o-1 approved by ada" },
    ]);
  });

  it("runs a typed step through the in-memory runner by its registered name", async () => {
    const steps = createStepRegistry();
    steps.register(chargeCard.stepType, chargeCard.handler);
    const charge = defineWorkflow<ChargeInput, Receipt>("charge-only", (ctx, input) =>
      ctx.step(chargeCard, input),
    );

    const outcome = await runWorkflowInMemory(
      charge.handler,
      { orderId: "o-9", cents: 5 },
      { ...sources, steps },
    );

    expect(outcome).toMatchObject({
      outcome: "completed",
      result: { receiptId: "r-o-9", cents: 5 },
    });
  });

  it("keeps updates typed through defineUpdate", () => {
    const addItem = defineUpdate<{ readonly sku: string }, number>("add-item", {
      handler: (argument) => argument.sku.length,
    });
    expectTypeOf(addItem.handler).parameter(0).toEqualTypeOf<{ readonly sku: string }>();
    expectTypeOf(addItem.handler).returns.toEqualTypeOf<number | Promise<number>>();
  });

  it("refuses an empty signal or query name", () => {
    expect(() => defineSignal("")).toThrow("a signal needs a name");
    expect(() => defineQuery("")).toThrow("a query needs a name");
  });
});
