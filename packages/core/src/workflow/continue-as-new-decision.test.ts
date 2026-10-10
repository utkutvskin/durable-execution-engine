import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { commandToEvent } from "./command-events.js";
import { runDecisionLoop } from "./decision-loop.js";
import { defineWorkflow } from "./define-workflow.js";
import { CancelledError } from "./errors.js";
import { runWorkflowInMemory } from "./run-workflow.js";
import type { ClockSource, RandomSource } from "./sources.js";
import { createStepRegistry } from "./step-registry.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

interface CounterInput {
  readonly next: number;
  readonly total: number;
  readonly end: number;
}

const BATCH = 50;

const counter = defineWorkflow("counter", async (ctx, input: CounterInput) => {
  let next = input.next;
  let total = input.total;
  for (let iteration = 0; iteration < BATCH && next <= input.end; iteration += 1) {
    total += await ctx.step<number>("add", { value: next });
    next += 1;
  }
  if (next > input.end) {
    return total;
  }
  return ctx.continueAsNew({ next, total, end: input.end });
});

function startedWith(input: unknown): WorkflowEvent {
  return { type: "run_started", workflowType: "counter", input };
}

const started = startedWith({});

interface Drive {
  readonly result: unknown;
  readonly runs: number;
  readonly maxHistoryLength: number;
}

async function driveToCompletion(end: number): Promise<Drive> {
  let input: CounterInput = { next: 1, total: 0, end };
  let history: WorkflowEvent[] = [startedWith(input)];
  let runs = 1;
  let maxHistoryLength = 0;
  for (;;) {
    const decision = await runDecisionLoop(counter.handler, input, history, sources);
    maxHistoryLength = Math.max(maxHistoryLength, history.length);
    if (decision.outcome === "completed") {
      return { result: decision.result, runs, maxHistoryLength };
    }
    if (decision.outcome === "continued_as_new") {
      input = decision.input as CounterInput;
      history = [startedWith(input)];
      runs += 1;
      continue;
    }
    for (const command of decision.commands) {
      if (command.type !== "schedule_step") {
        throw new Error(`unexpected command ${command.type}`);
      }
      const value = (command.input as { value: number }).value;
      history.push(commandToEvent(command), {
        type: "step_completed",
        stepId: command.stepId,
        result: value,
      });
    }
  }
}

describe("continue-as-new in the decision loop", () => {
  it("ends the decision with a single continue_as_new command carrying the new input", async () => {
    const decision = await runDecisionLoop(
      counter.handler,
      { next: 1, total: 0, end: 1000 },
      [started],
      sources,
    );

    expect(decision.outcome).toBe("suspended");

    const afterBatch: WorkflowEvent[] = [started];
    for (let index = 1; index <= BATCH; index += 1) {
      afterBatch.push(
        {
          type: "step_scheduled",
          stepId: `step-${String(index)}`,
          stepType: "add",
          input: { value: index },
        },
        { type: "step_completed", stepId: `step-${String(index)}`, result: index },
      );
    }
    const continued = await runDecisionLoop(
      counter.handler,
      { next: 1, total: 0, end: 1000 },
      afterBatch,
      sources,
    );

    expect(continued).toEqual({
      outcome: "continued_as_new",
      input: { next: 51, total: 1275, end: 1000 },
      commands: [{ type: "continue_as_new", input: { next: 51, total: 1275, end: 1000 } }],
    });
  });

  it("drops steps, timers and children the same decision would have started", async () => {
    const eager = defineWorkflow("eager", async (ctx) => {
      void ctx.step("side-effect", {});
      void ctx.sleep(1000);
      ctx.startChild("child", {});
      return ctx.continueAsNew({ again: true });
    });

    const decision = await runDecisionLoop(eager.handler, {}, [started], sources);

    expect(decision.commands).toEqual([{ type: "continue_as_new", input: { again: true } }]);
  });

  it("makes the same decision on every replay of the same history", async () => {
    const history: WorkflowEvent[] = [started];
    for (let index = 1; index <= BATCH; index += 1) {
      history.push(
        {
          type: "step_scheduled",
          stepId: `step-${String(index)}`,
          stepType: "add",
          input: { value: index },
        },
        { type: "step_completed", stepId: `step-${String(index)}`, result: index },
      );
    }
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        runDecisionLoop(counter.handler, { next: 1, total: 0, end: 500 }, history, sources),
      ),
    );

    expect(new Set(decisions.map((decision) => JSON.stringify(decision))).size).toBe(1);
  });

  it("rejects with CancelledError once cancellation was requested, so the run cannot continue", async () => {
    const stubborn = defineWorkflow("stubborn", async (ctx) => {
      try {
        return await ctx.continueAsNew({});
      } catch (error) {
        return error instanceof CancelledError ? "cancelled-instead" : "other";
      }
    });

    const decision = await runDecisionLoop(
      stubborn.handler,
      {},
      [started, { type: "cancel_requested" }],
      sources,
    );

    expect(decision.outcome).toBe("cancelled");
  });

  it("maps the command to a run_continued_as_new event", () => {
    expect(commandToEvent({ type: "continue_as_new", input: { n: 1 } })).toEqual({
      type: "run_continued_as_new",
      input: { n: 1 },
    });
  });

  it("warns once the history reaches the configured threshold and not before", async () => {
    const history: WorkflowEvent[] = [started];
    for (let index = 1; index <= 3; index += 1) {
      history.push(
        {
          type: "step_scheduled",
          stepId: `step-${String(index)}`,
          stepType: "add",
          input: { value: index },
        },
        { type: "step_completed", stepId: `step-${String(index)}`, result: index },
      );
    }
    const input = { next: 1, total: 0, end: 1000 };

    const below = await runDecisionLoop(counter.handler, input, history, {
      ...sources,
      historyWarningThreshold: 8,
    });
    const atThreshold = await runDecisionLoop(counter.handler, input, history, {
      ...sources,
      historyWarningThreshold: 7,
    });
    const unconfigured = await runDecisionLoop(counter.handler, input, history, sources);

    expect(below).not.toHaveProperty("historyWarning");
    expect(atThreshold.historyWarning).toEqual({ eventCount: 7, threshold: 7 });
    expect(unconfigured).not.toHaveProperty("historyWarning");
  });

  it("ends the in-memory runner with the continued_as_new outcome", async () => {
    const result = await runWorkflowInMemory(
      counter.handler,
      { next: 1, total: 0, end: 1000 },
      {
        ...sources,
        steps: (() => {
          const registry = createStepRegistry();
          registry.register("add", (input: unknown) => (input as { value: number }).value);
          return registry;
        })(),
      },
    );

    expect(result.outcome).toBe("continued_as_new");
    expect(result.commands.at(-1)).toEqual({
      type: "continue_as_new",
      input: { next: 51, total: 1275, end: 1000 },
    });
  });

  it("runs a 10000 iteration loop with a history that never grows past one batch", async () => {
    const small = await driveToCompletion(1000);
    const large = await driveToCompletion(10_000);

    expect(large.result).toBe(50_005_000);
    expect(large.runs).toBe(200);
    expect(large.maxHistoryLength).toBe(1 + 2 * BATCH);
    expect(small.maxHistoryLength).toBe(large.maxHistoryLength);
  }, 120_000);
});
