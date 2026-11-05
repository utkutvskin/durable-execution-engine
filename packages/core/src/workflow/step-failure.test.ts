import { describe, expect, it } from "vitest";
import { workflowEventSchema, type WorkflowEvent } from "../event-store/events.js";
import { commandToEvent } from "./command-events.js";
import { runDecisionLoop } from "./decision-loop.js";
import { defineWorkflow } from "./define-workflow.js";
import { serializeError } from "./error-serialization.js";
import { InvalidSleepDurationError, StepFailedError } from "./errors.js";
import { createLiveSession } from "./live-session.js";
import { runWorkflowInMemory } from "./run-workflow.js";
import { createStepRegistry } from "./step-registry.js";

const sources = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

class CardDeclinedError extends Error {
  readonly code: string;
  readonly attempts: number;

  constructor(message: string, code: string, attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "CardDeclinedError";
    this.code = code;
    this.attempts = attempts;
  }
}

const saga = defineWorkflow("saga", async (ctx) => {
  await ctx.step("reserve", {});
  try {
    await ctx.step("charge", {});
  } catch (error) {
    if (error instanceof StepFailedError) {
      await ctx.step("release", { failedStep: error.stepType });
      return "compensated";
    }
    throw error;
  }
  return "charged";
});

const started: WorkflowEvent = { type: "run_started", workflowType: "saga", input: {} };
const reserved: WorkflowEvent[] = [
  { type: "step_scheduled", stepId: "step-1", stepType: "reserve", input: {} },
  { type: "step_completed", stepId: "step-1", result: "held" },
  { type: "step_scheduled", stepId: "step-2", stepType: "charge", input: {} },
];

function exhaustedCharge(error = { name: "Error", message: "gateway down" }): WorkflowEvent {
  return { type: "step_failed", stepId: "step-2", error, exhausted: true };
}

describe("a step that exhausted its retries", () => {
  it("raises a StepFailedError the workflow catches to compensate", async () => {
    const decision = await runDecisionLoop(
      saga.handler,
      {},
      [started, ...reserved, exhaustedCharge()],
      sources,
    );

    expect(decision.outcome).toBe("suspended");
    expect(decision.commands).toEqual([
      {
        type: "schedule_step",
        stepId: "step-3",
        stepType: "release",
        input: { failedStep: "charge" },
      },
    ]);
  });

  it("finishes the compensation and completes the run", async () => {
    const decision = await runDecisionLoop(
      saga.handler,
      {},
      [
        started,
        ...reserved,
        exhaustedCharge(),
        {
          type: "step_scheduled",
          stepId: "step-3",
          stepType: "release",
          input: { failedStep: "charge" },
        },
        { type: "step_completed", stepId: "step-3", result: "released" },
      ],
      sources,
    );

    expect(decision).toMatchObject({ outcome: "completed", result: "compensated" });
  });

  it("carries the step's last error as the cause of the StepFailedError", async () => {
    let caught: unknown;
    const probe = defineWorkflow("probe", async (ctx) => {
      try {
        await ctx.step("charge", {});
      } catch (error) {
        caught = error;
      }
    });

    await runDecisionLoop(
      probe.handler,
      {},
      [
        { type: "run_started", workflowType: "probe", input: {} },
        { type: "step_scheduled", stepId: "step-1", stepType: "charge", input: {} },
        {
          type: "step_failed",
          stepId: "step-1",
          error: { name: "CardDeclinedError", message: "declined", details: { code: "D1" } },
          exhausted: true,
        },
      ],
      sources,
    );

    expect(caught).toBeInstanceOf(StepFailedError);
    expect(caught).toMatchObject({ name: "StepFailedError", stepId: "step-1", stepType: "charge" });
    expect((caught as StepFailedError).cause).toMatchObject({
      name: "CardDeclinedError",
      message: "declined",
      details: { code: "D1" },
    });
  });

  it("fails the run with a StepFailedError when the workflow does not catch it", async () => {
    const plain = defineWorkflow("plain", async (ctx) => ctx.step("charge", {}));

    const decision = await runDecisionLoop(
      plain.handler,
      {},
      [
        { type: "run_started", workflowType: "plain", input: {} },
        { type: "step_scheduled", stepId: "step-1", stepType: "charge", input: {} },
        {
          type: "step_failed",
          stepId: "step-1",
          error: { name: "Error", message: "down" },
          exhausted: true,
        },
      ],
      sources,
    );

    expect(decision.outcome).toBe("failed");
    expect(decision.commands.at(-1)).toMatchObject({
      type: "fail_run",
      error: { name: "StepFailedError", cause: { name: "Error", message: "down" } },
    });
  });

  it("still raises the original error for a step that failed without exhausting retries", async () => {
    let caught: unknown;
    const probe = defineWorkflow("probe", async (ctx) => {
      try {
        await ctx.step("charge", {});
      } catch (error) {
        caught = error;
      }
    });

    await runDecisionLoop(
      probe.handler,
      {},
      [
        { type: "run_started", workflowType: "probe", input: {} },
        { type: "step_scheduled", stepId: "step-1", stepType: "charge", input: {} },
        {
          type: "step_failed",
          stepId: "step-1",
          error: { name: "CardDeclinedError", message: "no" },
        },
      ],
      sources,
    );

    expect(caught).not.toBeInstanceOf(StepFailedError);
    expect(caught).toMatchObject({ name: "CardDeclinedError", message: "no" });
  });

  it("is raised the same way by a live session", async () => {
    const session = createLiveSession(saga.handler, {}, sources);

    const advance = await session.advance([started, ...reserved, exhaustedCharge()]);

    expect(advance.status).toBe("decided");
    if (advance.status === "decided") {
      expect(advance.decision.commands).toEqual([
        {
          type: "schedule_step",
          stepId: "step-3",
          stepType: "release",
          input: { failedStep: "charge" },
        },
      ]);
    }
  });
});

describe("a custom error class", () => {
  it("survives a failure event with its name, details and cause", async () => {
    const original = new CardDeclinedError("card declined", "D42", 3, {
      cause: new Error("issuer said no"),
    });
    const event = workflowEventSchema.parse({
      type: "step_failed",
      stepId: "step-1",
      error: serializeError(original),
    });
    let caught: unknown;
    const probe = defineWorkflow("probe", async (ctx) => {
      try {
        await ctx.step("charge", {});
      } catch (error) {
        caught = error;
      }
    });

    await runDecisionLoop(
      probe.handler,
      {},
      [
        { type: "run_started", workflowType: "probe", input: {} },
        { type: "step_scheduled", stepId: "step-1", stepType: "charge", input: {} },
        event,
      ],
      sources,
    );

    expect(caught).toMatchObject({ name: "CardDeclinedError", message: "card declined" });
    expect((caught as { details: unknown }).details).toEqual({ code: "D42", attempts: 3 });
    expect((caught as Error).cause).toMatchObject({ message: "issuer said no" });
  });

  it("stays in the failure event when the workflow lets it fail the run", async () => {
    const plain = defineWorkflow("plain", () =>
      Promise.reject(new CardDeclinedError("declined", "D1", 1)),
    );

    const decision = await runDecisionLoop(
      plain.handler,
      {},
      [{ type: "run_started", workflowType: "plain", input: {} }],
      sources,
    );

    expect(decision.commands.map(commandToEvent).at(-1)).toEqual({
      type: "run_failed",
      error: {
        name: "CardDeclinedError",
        message: "declined",
        details: { code: "D1", attempts: 1 },
      },
    });
  });
});

describe("a failing compensation", () => {
  const cancelRequested: WorkflowEvent = { type: "cancel_requested" };
  const brittle = defineWorkflow("brittle", async (ctx) => {
    ctx.onCancel(() => Promise.reject(new CardDeclinedError("refund failed", "R1", 1)));
    await ctx.waitForSignal("never");
  });

  it("is recorded as a compensation_failed event with the error", async () => {
    const decision = await runDecisionLoop(
      brittle.handler,
      {},
      [{ type: "run_started", workflowType: "brittle", input: {} }, cancelRequested],
      sources,
    );

    expect(decision.outcome).toBe("cancelled");
    expect(decision.commands.map(commandToEvent)).toEqual([
      {
        type: "compensation_failed",
        index: 0,
        error: {
          name: "CardDeclinedError",
          message: "refund failed",
          details: { code: "R1", attempts: 1 },
        },
      },
      { type: "run_cancelled" },
    ]);
  });

  it("is not recorded a second time once the history holds it", async () => {
    const waiting = defineWorkflow("waiting", async (ctx) => {
      ctx.onCancel(async (compensation) => {
        await compensation.step("undo", {});
      });
      ctx.onCancel(() => Promise.reject(new Error("first broke")));
      await ctx.waitForSignal("never");
    });
    const decision = await runDecisionLoop(
      waiting.handler,
      {},
      [
        { type: "run_started", workflowType: "waiting", input: {} },
        cancelRequested,
        { type: "compensation_failed", index: 1, error: { name: "Error", message: "first broke" } },
        { type: "step_scheduled", stepId: "step-1", stepType: "undo", input: {} },
      ],
      sources,
    );

    expect(decision.outcome).toBe("suspended");
    expect(decision.commands).toEqual([]);
  });
});

describe("ctx.sleep with an invalid duration", () => {
  const sleeper = (durationMs: number) =>
    defineWorkflow("sleeper", async (ctx) => {
      await ctx.sleep(durationMs);
      return "slept";
    });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    "rejects %s with an InvalidSleepDurationError in a decision",
    async (duration) => {
      const decision = await runDecisionLoop(
        sleeper(duration).handler,
        {},
        [{ type: "run_started", workflowType: "sleeper", input: {} }],
        sources,
      );

      expect(decision.outcome).toBe("failed");
      expect(decision.outcome === "failed" && decision.error).toBeInstanceOf(
        InvalidSleepDurationError,
      );
      expect(decision.commands.map((command) => command.type)).toEqual(["fail_run"]);
    },
  );

  it("names the bad duration in its message", async () => {
    const decision = await runDecisionLoop(
      sleeper(-250).handler,
      {},
      [{ type: "run_started", workflowType: "sleeper", input: {} }],
      sources,
    );

    expect(decision.outcome === "failed" && decision.error.message).toMatch(/non-negative.*-250/);
  });

  it("rejects the same way in the in-memory runner", async () => {
    const outcome = await runWorkflowInMemory(
      sleeper(Number.NaN).handler,
      {},
      {
        ...sources,
        steps: createStepRegistry(),
      },
    );

    expect(outcome.outcome).toBe("failed");
  });

  it("still starts a timer for zero", async () => {
    const decision = await runDecisionLoop(
      sleeper(0).handler,
      {},
      [{ type: "run_started", workflowType: "sleeper", input: {} }],
      sources,
    );

    expect(decision.commands.map((command) => command.type)).toEqual(["start_timer"]);
  });
});
