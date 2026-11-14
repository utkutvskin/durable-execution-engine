import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.ts";
import { runDecisionLoop } from "./decision-loop.ts";
import { defineUpdate } from "./define-update.ts";
import { defineWorkflow } from "./define-workflow.ts";
import { NonDeterminismError } from "./errors.ts";
import type { ClockSource, RandomSource } from "./sources.ts";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const paymentWait = defineWorkflow("payment-wait", async (ctx, input: { orderId: string }) => {
  try {
    const paid = await ctx.waitForEvent<{ amount: number }>("payment.received", {
      match: input.orderId,
      timeoutMs: 60_000,
    });
    return `paid ${String(paid.amount)}`;
  } catch (error) {
    return error instanceof Error ? error.name : "unknown";
  }
});

const started: WorkflowEvent = {
  type: "run_started",
  workflowType: "payment-wait",
  input: { orderId: "o-1" },
};

const waitStarted: WorkflowEvent = {
  type: "event_wait_started",
  waitId: "wait-1",
  eventName: "payment.received",
  key: "o-1",
  expiresAt: "2026-01-01T00:01:00.000Z",
};

const timerStarted: WorkflowEvent = {
  type: "timer_started",
  timerId: "timer-1",
  fireAt: "2026-01-01T00:01:00.000Z",
  durationMs: 60_000,
};

const received: WorkflowEvent = {
  type: "event_received",
  waitId: "wait-1",
  eventId: "e-1",
  eventName: "payment.received",
  key: "o-1",
  payload: { amount: 42 },
};

describe("ctx.waitForEvent in the decision loop", () => {
  it("records the wait with its correlation key and expiry, and the timeout timer", async () => {
    const result = await runDecisionLoop(
      paymentWait.handler,
      { orderId: "o-1" },
      [started],
      sources,
    );

    expect(result).toEqual({
      outcome: "suspended",
      commands: [
        {
          type: "wait_for_event",
          waitId: "wait-1",
          eventName: "payment.received",
          key: "o-1",
          expiresAt: "2026-01-01T00:01:00.000Z",
        },
        {
          type: "start_timer",
          timerId: "timer-1",
          fireAt: "2026-01-01T00:01:00.000Z",
          durationMs: 60_000,
        },
      ],
    });
  });

  it("resolves with the payload of the delivered event", async () => {
    const history = [started, waitStarted, timerStarted, received];

    const result = await runDecisionLoop(paymentWait.handler, { orderId: "o-1" }, history, sources);

    expect(result).toMatchObject({ outcome: "completed", result: "paid 42" });
  });

  it("rejects with EventWaitTimeoutError when the timer fires first", async () => {
    const history: WorkflowEvent[] = [
      started,
      waitStarted,
      timerStarted,
      { type: "timer_fired", timerId: "timer-1" },
      received,
    ];

    const result = await runDecisionLoop(paymentWait.handler, { orderId: "o-1" }, history, sources);

    expect(result).toMatchObject({ outcome: "completed", result: "EventWaitTimeoutError" });
  });

  it("refuses a replay whose code waits for another correlation key", async () => {
    const history = [started, waitStarted, timerStarted];

    await expect(
      runDecisionLoop(paymentWait.handler, { orderId: "o-2" }, history, sources),
    ).rejects.toBeInstanceOf(NonDeterminismError);
  });
});

describe("ctx.condition in the decision loop", () => {
  const threshold = defineWorkflow("threshold", async (ctx) => {
    let total = 0;
    ctx.setUpdateHandler(
      defineUpdate<number, number>("add", {
        handler: (amount) => {
          total += amount;
          return total;
        },
      }),
    );
    const reached = await ctx.condition(() => total >= 10, 30_000);
    return reached ? `reached ${String(total)}` : `timed out at ${String(total)}`;
  });

  const thresholdStart: WorkflowEvent = {
    type: "run_started",
    workflowType: "threshold",
    input: {},
  };
  const thresholdTimer: WorkflowEvent = {
    type: "timer_started",
    timerId: "timer-1",
    fireAt: "2026-01-01T00:00:30.000Z",
    durationMs: 30_000,
  };

  function added(updateId: string, amount: number): WorkflowEvent {
    return { type: "update_accepted", updateId, updateName: "add", argument: amount };
  }

  it("starts the timeout timer when the predicate is false at the call", async () => {
    const result = await runDecisionLoop(threshold.handler, {}, [thresholdStart], sources);

    expect(result).toEqual({
      outcome: "suspended",
      commands: [
        {
          type: "start_timer",
          timerId: "timer-1",
          fireAt: "2026-01-01T00:00:30.000Z",
          durationMs: 30_000,
        },
      ],
    });
  });

  it("resolves true at the history position where the state makes the predicate true", async () => {
    const history: WorkflowEvent[] = [
      thresholdStart,
      thresholdTimer,
      added("u-1", 4),
      { type: "update_completed", updateId: "u-1", result: 4 },
      added("u-2", 7),
      { type: "update_completed", updateId: "u-2", result: 11 },
      { type: "timer_fired", timerId: "timer-1" },
    ];

    const result = await runDecisionLoop(threshold.handler, {}, history, sources);

    expect(result).toMatchObject({ outcome: "completed", result: "reached 11" });
  });

  it("resolves false when its timer fires before the predicate holds", async () => {
    const history: WorkflowEvent[] = [
      thresholdStart,
      thresholdTimer,
      added("u-1", 4),
      { type: "update_completed", updateId: "u-1", result: 4 },
      { type: "timer_fired", timerId: "timer-1" },
      added("u-2", 7),
    ];

    const result = await runDecisionLoop(threshold.handler, {}, history, sources);

    expect(result).toMatchObject({ outcome: "completed", result: "timed out at 4" });
  });

  it("resolves at once without a timer when the predicate already holds", async () => {
    const immediate = defineWorkflow("immediate", async (ctx) => ctx.condition(() => true, 5_000));

    const result = await runDecisionLoop(
      immediate.handler,
      {},
      [{ type: "run_started", workflowType: "immediate", input: {} }],
      sources,
    );

    expect(result).toEqual({
      outcome: "completed",
      result: true,
      commands: [{ type: "complete_run", result: true }],
    });
  });

  it("wakes on a signal consumed by other code in the same workflow", async () => {
    const counter = defineWorkflow("counter", async (ctx) => {
      let seen = 0;
      const listen = async (): Promise<void> => {
        for (;;) {
          await ctx.waitForSignal("tick");
          seen += 1;
        }
      };
      void listen();
      await ctx.condition(() => seen === 2);
      return seen;
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "counter", input: {} },
      { type: "signal_received", signalName: "tick", payload: null },
      { type: "signal_received", signalName: "tick", payload: null },
    ];

    const first = await runDecisionLoop(counter.handler, {}, history, sources);
    const second = await runDecisionLoop(counter.handler, {}, history, sources);

    expect(first).toMatchObject({ outcome: "completed", result: 2 });
    expect(second).toEqual(first);
  });
});

describe("continue as new carries unconsumed signals", () => {
  const batcher = defineWorkflow("batcher", async (ctx) => {
    const first = await ctx.waitForSignal<string>("item");
    await ctx.step("process", first);
    return ctx.continueAsNew({});
  });

  it("puts every signal the run did not consume on the continue_as_new command, in order", async () => {
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "batcher", input: {} },
      { type: "signal_received", signalName: "item", payload: "a", signalId: "s-a" },
      { type: "step_scheduled", stepId: "step-1", stepType: "process", input: "a" },
      { type: "signal_received", signalName: "item", payload: "b" },
      { type: "signal_received", signalName: "other", payload: 1 },
      { type: "step_completed", stepId: "step-1", result: null },
      { type: "signal_received", signalName: "item", payload: "c", signalId: "s-c" },
    ];

    const result = await runDecisionLoop(batcher.handler, {}, history, sources);

    expect(result.commands).toEqual([
      {
        type: "continue_as_new",
        input: {},
        signals: [
          { signalName: "item", payload: "b" },
          { signalName: "other", payload: 1 },
          { signalName: "item", payload: "c", signalId: "s-c" },
        ],
      },
    ]);
  });

  it("carries nothing when every signal was consumed", async () => {
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "batcher", input: {} },
      { type: "signal_received", signalName: "item", payload: "a" },
      { type: "step_scheduled", stepId: "step-1", stepType: "process", input: "a" },
      { type: "step_completed", stepId: "step-1", result: null },
    ];

    const result = await runDecisionLoop(batcher.handler, {}, history, sources);

    expect(result.commands).toEqual([{ type: "continue_as_new", input: {} }]);
  });
});
