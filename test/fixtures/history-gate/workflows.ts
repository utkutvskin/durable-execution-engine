import { defineStep } from "../../../packages/core/src/workflow/define-step.ts";
import { defineUpdate } from "../../../packages/core/src/workflow/define-update.ts";
import { defineWorkflow } from "../../../packages/core/src/workflow/define-workflow.ts";

/**
 * The workflows the history gate fixtures were recorded with. Between them
 * they write every event type. A fixture history stays valid only as long
 * as these handlers make the same calls in the same order: changing one on
 * purpose means recording the fixtures again (see `record.ts`).
 */
export const workflows = [
  defineWorkflow("gate-order", async (ctx, input: { readonly orderId: string }) => {
    const charge = await ctx.step<{ readonly charged: boolean }>("gate.charge", input);
    await ctx.sleep(20);
    const checkedAt = ctx.now().toISOString();
    const express = ctx.patched("gate-express");
    const approval = await ctx.waitForSignal<{ readonly by: string }>("approve");
    const label = await ctx.executeChild<string>("gate-label", { orderId: input.orderId });
    const shipped = await ctx.step<string>("gate.ship", { orderId: input.orderId, express });
    return { charge, checkedAt, approvedBy: approval.by, label, shipped };
  }),
  defineWorkflow("gate-label", async (ctx, input: { readonly orderId: string }) =>
    ctx.step<string>("gate.label", input),
  ),
  defineWorkflow("gate-failures", async (ctx, input: { readonly orderId: string }) => {
    let childError = "";
    try {
      await ctx.executeChild("gate-broken-child", input);
    } catch (error) {
      childError = error instanceof Error ? error.name : String(error);
    }
    await ctx.step("gate.flaky", { orderId: input.orderId, childError });
    return "unreachable";
  }),
  defineWorkflow("gate-broken-child", async (ctx, input: { readonly orderId: string }) => {
    await ctx.step("gate.label", input);
    throw new Error(`child of ${input.orderId} gave up`);
  }),
  defineWorkflow("gate-cancel", async (ctx, input: { readonly orderId: string }) => {
    ctx.onCancel(async (compensation) => {
      await compensation.step("gate.refund", input);
    });
    ctx.onCancel(() => Promise.reject(new Error("release failed")));
    await ctx.waitForSignal("never");
    return "never";
  }),
  defineWorkflow("gate-loop", async (ctx, input: { readonly round: number }) => {
    const done = await ctx.step<number>("gate.count", input);
    if (input.round < 1) {
      return ctx.continueAsNew({ round: input.round + 1 });
    }
    return done;
  }),
  defineWorkflow("gate-waiting", async (ctx) => ctx.waitForSignal("never")),
  defineWorkflow("gate-event", async (ctx, input: { readonly orderId: string }) =>
    ctx.waitForEvent<{ readonly amount: number }>("gate.paid", {
      match: input.orderId,
      timeoutMs: 60_000,
    }),
  ),
  defineWorkflow("gate-update", async (ctx) => {
    const notes: string[] = [];
    ctx.setUpdateHandler(
      defineUpdate<string, number>("gate.note", {
        validate: (note) => {
          if (note.length === 0) {
            throw new Error("a note cannot be empty");
          }
        },
        handler: (note) => {
          notes.push(note);
          return notes.length;
        },
      }),
    );
    ctx.setUpdateHandler(
      defineUpdate("gate.refuse", {
        handler: () => {
          throw new Error("refused by the workflow");
        },
      }),
    );
    await ctx.waitForSignal("close");
    return notes;
  }),
];

/**
 * The steps of the gate workflows. `gate.flaky` always fails, twice.
 */
export const steps = [
  defineStep("gate.charge", { handler: () => ({ charged: true }) }),
  defineStep("gate.ship", { handler: () => "shipped" }),
  defineStep("gate.label", {
    handler: (input: { readonly orderId: string }) => `label-${input.orderId}`,
  }),
  defineStep("gate.refund", { handler: () => "refunded" }),
  defineStep("gate.count", { handler: (input: { readonly round: number }) => input.round }),
  defineStep("gate.flaky", {
    handler: () => {
      throw new Error("the carrier is down");
    },
    retry: { maxAttempts: 2, initialIntervalMs: 10, maxIntervalMs: 10, jitter: 0 },
  }),
];
