import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { runDecisionLoop } from "./decision-loop.js";
import { defineWorkflow } from "./define-workflow.js";
import { CancelledError } from "./errors.js";
import type { ClockSource, RandomSource } from "./sources.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const saga = defineWorkflow("trip", async (ctx) => {
  await ctx.step("book-flight", { id: "f" });
  ctx.onCancel(async (compensation) => {
    await compensation.step("refund-flight", { id: "f" });
  });
  await ctx.step("book-hotel", { id: "h" });
  ctx.onCancel(async (compensation) => {
    await compensation.step("cancel-hotel", { id: "h" });
  });
  await ctx.waitForSignal("confirm");
  return "booked";
});

const started: WorkflowEvent = { type: "run_started", workflowType: "trip", input: {} };

function stepDone(stepId: string, stepType: string, input: unknown): WorkflowEvent[] {
  return [
    { type: "step_scheduled", stepId, stepType, input },
    { type: "step_completed", stepId, result: null },
  ];
}

const bookedBoth: WorkflowEvent[] = [
  started,
  ...stepDone("step-1", "book-flight", { id: "f" }),
  ...stepDone("step-2", "book-hotel", { id: "h" }),
];

const cancelRequested: WorkflowEvent = { type: "cancel_requested", reason: "customer" };

describe("cancellation in the decision loop", () => {
  it("schedules the latest compensation first once cancellation is requested", async () => {
    const result = await runDecisionLoop(
      saga.handler,
      {},
      [...bookedBoth, cancelRequested],
      sources,
    );

    expect(result).toEqual({
      outcome: "suspended",
      commands: [
        { type: "schedule_step", stepId: "step-3", stepType: "cancel-hotel", input: { id: "h" } },
      ],
    });
  });

  it("runs the compensations in reverse order and then cancels the run", async () => {
    const history: WorkflowEvent[] = [
      ...bookedBoth,
      cancelRequested,
      ...stepDone("step-3", "cancel-hotel", { id: "h" }),
    ];

    const midway = await runDecisionLoop(saga.handler, {}, history, sources);
    expect(midway.commands).toEqual([
      { type: "schedule_step", stepId: "step-4", stepType: "refund-flight", input: { id: "f" } },
    ]);

    const finished = await runDecisionLoop(
      saga.handler,
      {},
      [...history, ...stepDone("step-4", "refund-flight", { id: "f" })],
      sources,
    );
    expect(finished).toEqual({
      outcome: "cancelled",
      commands: [{ type: "cancel_run", reason: "customer" }],
    });
  });

  it("schedules no new step after cancellation was requested", async () => {
    const looping = defineWorkflow("looping", async (ctx) => {
      for (let round = 0; round < 5; round += 1) {
        await ctx.step("work", { round });
      }
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "looping", input: {} },
      ...stepDone("step-1", "work", { round: 0 }),
      cancelRequested,
    ];

    const result = await runDecisionLoop(looping.handler, {}, history, sources);

    expect(result).toEqual({
      outcome: "cancelled",
      commands: [{ type: "cancel_run", reason: "customer" }],
    });
  });

  it("waits for the step that is running when cancellation arrives", async () => {
    const history: WorkflowEvent[] = [
      started,
      ...stepDone("step-1", "book-flight", { id: "f" }),
      { type: "step_scheduled", stepId: "step-2", stepType: "book-hotel", input: { id: "h" } },
      cancelRequested,
    ];

    const waiting = await runDecisionLoop(saga.handler, {}, history, sources);
    expect(waiting).toEqual({ outcome: "suspended", commands: [] });

    const settled = await runDecisionLoop(
      saga.handler,
      {},
      [...history, { type: "step_completed", stepId: "step-2", result: null }],
      sources,
    );
    expect(settled.commands).toEqual([
      { type: "schedule_step", stepId: "step-3", stepType: "cancel-hotel", input: { id: "h" } },
    ]);
  });

  it("rejects an unfinished wait with CancelledError, which the workflow may catch", async () => {
    const seen: string[] = [];
    const tidy = defineWorkflow("tidy", async (ctx) => {
      try {
        await ctx.waitForSignal("never");
      } catch (error) {
        seen.push(error instanceof CancelledError ? error.name : "other");
        throw error;
      }
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "tidy", input: {} },
      cancelRequested,
    ];

    const result = await runDecisionLoop(tidy.handler, {}, history, sources);

    expect(seen).toEqual(["CancelledError"]);
    expect(result.outcome).toBe("cancelled");
  });

  it("keeps running the remaining compensations when one of them throws", async () => {
    const brittle = defineWorkflow("brittle", async (ctx) => {
      ctx.onCancel(async (compensation) => {
        await compensation.step("second", {});
      });
      ctx.onCancel(() => Promise.reject(new Error("first compensation broke")));
      await ctx.waitForSignal("never");
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "brittle", input: {} },
      cancelRequested,
    ];

    const result = await runDecisionLoop(brittle.handler, {}, history, sources);

    expect(result.commands).toEqual([
      { type: "schedule_step", stepId: "step-1", stepType: "second", input: {} },
    ]);
  });

  it("does not run compensations when the run is not cancelled", async () => {
    const history: WorkflowEvent[] = [
      ...bookedBoth,
      { type: "signal_received", signalName: "confirm", payload: null },
    ];

    const result = await runDecisionLoop(saga.handler, {}, history, sources);

    expect(result).toEqual({
      outcome: "completed",
      result: "booked",
      commands: [{ type: "complete_run", result: "booked" }],
    });
  });

  it("makes the same cancellation decision on repeated replays", async () => {
    const history: WorkflowEvent[] = [...bookedBoth, cancelRequested];

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => runDecisionLoop(saga.handler, {}, history, sources)),
    );

    expect(new Set(decisions.map((decision) => JSON.stringify(decision))).size).toBe(1);
  });
});
