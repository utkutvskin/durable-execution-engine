import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { runDecisionLoop } from "./decision-loop.js";
import { defineWorkflow } from "./define-workflow.js";
import { runQuery, UnknownQueryError } from "./query.js";
import type { ClockSource, RandomSource } from "./sources.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const started: WorkflowEvent = { type: "run_started", workflowType: "approval", input: {} };

const approval = defineWorkflow("approval", async (ctx) => {
  const decision = await ctx.waitForSignal<{ approved: boolean }>("decision");
  return decision.approved ? "approved" : "rejected";
});

const raceWorkflow = defineWorkflow("race", async (ctx) => {
  const outcome = await ctx.select([ctx.waitForSignal<string>("approve"), ctx.sleep(60_000)]);
  return outcome.index === 0 ? `signal:${String(outcome.value)}` : "timeout";
});

describe("signals in the decision loop", () => {
  it("suspends without commands while no signal has arrived", async () => {
    const result = await runDecisionLoop(approval.handler, {}, [started], sources);
    expect(result).toEqual({ outcome: "suspended", commands: [] });
  });

  it("delivers a signal that was recorded before the run started waiting", async () => {
    const buffered = defineWorkflow("buffered", async (ctx) => {
      await ctx.step("prepare", {});
      return ctx.waitForSignal("go");
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "buffered", input: {} },
      { type: "signal_received", signalName: "go", payload: "early" },
      { type: "step_scheduled", stepId: "step-1", stepType: "prepare", input: {} },
      { type: "step_completed", stepId: "step-1", result: null },
    ];
    const result = await runDecisionLoop(buffered.handler, {}, history, sources);
    expect(result).toMatchObject({ outcome: "completed", result: "early" });
  });

  it("consumes signals of one name in arrival order, one per wait", async () => {
    const twice = defineWorkflow("twice", async (ctx) => {
      const first = await ctx.waitForSignal("tick");
      const second = await ctx.waitForSignal("tick");
      return [first, second];
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "twice", input: {} },
      { type: "signal_received", signalName: "tick", payload: 1 },
      { type: "signal_received", signalName: "other", payload: "x" },
      { type: "signal_received", signalName: "tick", payload: 2 },
    ];
    const result = await runDecisionLoop(twice.handler, {}, history, sources);
    expect(result).toMatchObject({ outcome: "completed", result: [1, 2] });
  });

  it("keeps signals of different names apart", async () => {
    const history: WorkflowEvent[] = [
      started,
      { type: "signal_received", signalName: "other", payload: { approved: true } },
    ];
    const result = await runDecisionLoop(approval.handler, {}, history, sources);
    expect(result.outcome).toBe("suspended");
  });
});

describe("select", () => {
  it("stays suspended and starts the timer while neither branch completed", async () => {
    const result = await runDecisionLoop(raceWorkflow.handler, {}, [started], sources);
    expect(result.outcome).toBe("suspended");
    expect(result.commands).toEqual([
      { type: "start_timer", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
    ]);
  });

  it("picks the signal when it was recorded before the timer fired", async () => {
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "race", input: {} },
      { type: "timer_started", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
      { type: "signal_received", signalName: "approve", payload: "yes" },
      { type: "timer_fired", timerId: "timer-1" },
    ];
    const result = await runDecisionLoop(raceWorkflow.handler, {}, history, sources);
    expect(result).toMatchObject({ outcome: "completed", result: "signal:yes" });
  });

  it("picks the timer when it fired before the signal was recorded", async () => {
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "race", input: {} },
      { type: "timer_started", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
      { type: "timer_fired", timerId: "timer-1" },
      { type: "signal_received", signalName: "approve", payload: "late" },
    ];
    const result = await runDecisionLoop(raceWorkflow.handler, {}, history, sources);
    expect(result).toMatchObject({ outcome: "completed", result: "timeout" });
  });

  it("picks the same branch on every replay of one history", async () => {
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "race", input: {} },
      { type: "timer_started", timerId: "timer-1", fireAt: "2026-01-01T00:01:00.000Z" },
      { type: "timer_fired", timerId: "timer-1" },
      { type: "signal_received", signalName: "approve", payload: "late" },
    ];
    const results = await Promise.all(
      Array.from({ length: 10 }, () => runDecisionLoop(raceWorkflow.handler, {}, history, sources)),
    );
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
  });

  it("picks the signal over a step that completed after it", async () => {
    const stepRace = defineWorkflow("step-race", async (ctx) => {
      const outcome = await ctx.select([ctx.step("slow", {}), ctx.waitForSignal("abort")]);
      return outcome.index;
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "step-race", input: {} },
      { type: "step_scheduled", stepId: "step-1", stepType: "slow", input: {} },
      { type: "signal_received", signalName: "abort", payload: null },
      { type: "step_completed", stepId: "step-1", result: "done" },
    ];
    const result = await runDecisionLoop(stepRace.handler, {}, history, sources);
    expect(result).toMatchObject({ outcome: "completed", result: 1 });
  });
});

describe("runQuery", () => {
  const counter = defineWorkflow("counter", async (ctx) => {
    const received: unknown[] = [];
    ctx.setQueryHandler("received", () => [...received]);
    ctx.setQueryHandler("count", (argument) => received.length + Number(argument ?? 0));
    for (;;) {
      received.push(await ctx.waitForSignal("item"));
    }
  });

  const history: WorkflowEvent[] = [
    { type: "run_started", workflowType: "counter", input: {} },
    { type: "signal_received", signalName: "item", payload: "a" },
    { type: "signal_received", signalName: "item", payload: "b" },
  ];

  it("answers from the state the replay reached", async () => {
    const answer = await runQuery(counter.handler, {}, history, sources, "received");
    expect(answer).toEqual(["a", "b"]);
  });

  it("passes the query argument to the handler", async () => {
    const answer = await runQuery(counter.handler, {}, history, sources, "count", 10);
    expect(answer).toBe(12);
  });

  it("rejects an unknown query name", async () => {
    await expect(runQuery(counter.handler, {}, history, sources, "nope")).rejects.toBeInstanceOf(
      UnknownQueryError,
    );
  });
});
