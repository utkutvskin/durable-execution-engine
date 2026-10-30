import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { createRunCache } from "../sticky/run-cache.js";
import { createStickyDecider } from "../sticky/sticky-decider.js";
import { commandToEvent } from "./command-events.js";
import type { WorkflowHandler } from "./context.js";
import { runDecisionLoop } from "./decision-loop.js";
import { NonDeterminismError } from "./errors.js";
import type { LiveSession } from "./live-session.js";
import type { ClockSource } from "./sources.js";

const clock: ClockSource = { now: () => new Date("2026-01-01T00:00:00.000Z") };
const startedAt = new Date("2026-01-01T00:00:00.000Z");

const runStarted: WorkflowEvent = { type: "run_started", workflowType: "w", input: {} };

function scheduled(stepId: string, stepType: string): WorkflowEvent {
  return { type: "step_scheduled", stepId, stepType, input: {} };
}

function completed(stepId: string): WorkflowEvent {
  return { type: "step_completed", stepId, result: { ok: true } };
}

function signal(signalName: string): WorkflowEvent {
  return { type: "signal_received", signalName, payload: { from: "test" } };
}

async function coldDecide(handler: WorkflowHandler, history: readonly WorkflowEvent[]) {
  return runDecisionLoop(handler, {}, history, { clock, runId: "run-1", triggeredAt: startedAt });
}

async function stickyDecideEventByEvent(
  handler: WorkflowHandler,
  history: readonly WorkflowEvent[],
) {
  const decider = createStickyDecider({
    cache: createRunCache<LiveSession>({ maxRuns: 4, stickyTimeoutMs: 60_000 }),
    decisionOptions: { clock },
  });
  let last = await decider.decide("run-1", handler, {}, history.slice(0, 1), startedAt);
  for (let length = 2; length <= history.length; length += 1) {
    last = await decider.decide("run-1", handler, {}, history.slice(0, length), startedAt);
  }
  return last.decision;
}

const signalThenBranch: WorkflowHandler = async (ctx) => {
  const seen = { signal: false };
  void ctx.waitForSignal("nudge").then(() => {
    seen.signal = true;
  });
  await ctx.step("first", {});
  await ctx.step(seen.signal ? "after-signal" : "before-signal", {});
  return "done";
};

describe("replay in history order", () => {
  const finishedBeforeSignal: WorkflowEvent[] = [
    runStarted,
    scheduled("step-1", "first"),
    completed("step-1"),
    scheduled("step-2", "before-signal"),
    signal("nudge"),
    completed("step-2"),
  ];

  it("takes the branch of a signal handled in then() after the step it arrived behind, on a cold replay", async () => {
    const decision = await coldDecide(signalThenBranch, finishedBeforeSignal);
    expect(decision.outcome).toBe("completed");
  });

  it("takes the same branch on a sticky session fed one event at a time", async () => {
    const decision = await stickyDecideEventByEvent(signalThenBranch, finishedBeforeSignal);
    expect(decision.outcome).toBe("completed");
  });

  it("takes the other branch when the signal arrived first", async () => {
    const signalFirst: WorkflowEvent[] = [
      runStarted,
      scheduled("step-1", "first"),
      signal("nudge"),
      completed("step-1"),
      scheduled("step-2", "after-signal"),
      completed("step-2"),
    ];
    const cold = await coldDecide(signalThenBranch, signalFirst);
    const sticky = await stickyDecideEventByEvent(signalThenBranch, signalFirst);
    expect(cold.outcome).toBe("completed");
    expect(sticky.outcome).toBe("completed");
  });
});

describe("complete command matching", () => {
  it("records the duration of a timer on its start command", async () => {
    const sleeper: WorkflowHandler = async (ctx) => {
      await ctx.sleep(1000);
    };
    const decision = await coldDecide(sleeper, [runStarted]);
    expect(decision.commands).toContainEqual({
      type: "start_timer",
      timerId: "timer-1",
      fireAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });
  });

  it("raises NonDeterminismError when a timer duration changed", async () => {
    const original: WorkflowHandler = async (ctx) => {
      await ctx.sleep(1000);
    };
    const first = await coldDecide(original, [runStarted]);
    const history = [runStarted, ...first.commands.map(commandToEvent)];
    const changed: WorkflowHandler = async (ctx) => {
      await ctx.sleep(2000);
    };
    await expect(coldDecide(changed, history)).rejects.toBeInstanceOf(NonDeterminismError);
  });

  it("raises NonDeterminismError when a step was swapped for a sleep", async () => {
    const swapped: WorkflowHandler = async (ctx) => {
      await ctx.sleep(10);
    };
    await expect(
      coldDecide(swapped, [runStarted, scheduled("step-1", "work")]),
    ).rejects.toBeInstanceOf(NonDeterminismError);
  });

  it("raises NonDeterminismError when a sleep was swapped for a step", async () => {
    const swapped: WorkflowHandler = async (ctx) => {
      await ctx.step("work", {});
    };
    const timer: WorkflowEvent = {
      type: "timer_started",
      timerId: "timer-1",
      fireAt: "2026-01-01T00:00:01.000Z",
    };
    await expect(coldDecide(swapped, [runStarted, timer])).rejects.toBeInstanceOf(
      NonDeterminismError,
    );
  });

  it("raises NonDeterminismError when a trailing step was removed", async () => {
    const shortened: WorkflowHandler = async (ctx) => {
      await ctx.step("one", {});
    };
    const history = [
      runStarted,
      scheduled("step-1", "one"),
      completed("step-1"),
      scheduled("step-2", "two"),
      completed("step-2"),
    ];
    await expect(coldDecide(shortened, history)).rejects.toBeInstanceOf(NonDeterminismError);
  });

  it("raises NonDeterminismError on a sticky session when a trailing step was removed", async () => {
    const shortened: WorkflowHandler = async (ctx) => {
      await ctx.step("one", {});
    };
    const history = [
      runStarted,
      scheduled("step-1", "one"),
      completed("step-1"),
      scheduled("step-2", "two"),
      completed("step-2"),
    ];
    await expect(stickyDecideEventByEvent(shortened, history)).rejects.toBeInstanceOf(
      NonDeterminismError,
    );
  });

  it("accepts a recorded timer start that has no duration, as old histories hold", async () => {
    const sleeper: WorkflowHandler = async (ctx) => {
      await ctx.sleep(1000);
    };
    const timer: WorkflowEvent = {
      type: "timer_started",
      timerId: "timer-1",
      fireAt: "2026-01-01T00:00:01.000Z",
    };
    const decision = await coldDecide(sleeper, [runStarted, timer]);
    expect(decision.outcome).toBe("suspended");
  });

  it("does not count a sleep that a cancelled run never started", async () => {
    const waiting: WorkflowHandler = async (ctx) => {
      ctx.onCancel(async (compensation) => {
        await compensation.step("release", {});
      });
      await ctx.step("reserve", {});
      await ctx.sleep(1000);
    };
    const history = [
      runStarted,
      scheduled("step-1", "reserve"),
      completed("step-1"),
      { type: "cancel_requested" } as const,
      scheduled("step-2", "release"),
      completed("step-2"),
    ];
    const decision = await coldDecide(waiting, history);
    expect(decision.outcome).toBe("cancelled");
  });
});
