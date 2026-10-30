import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { createRunCache } from "../sticky/run-cache.js";
import { createStickyDecider } from "../sticky/sticky-decider.js";
import { commandToEvent } from "./command-events.js";
import type { WorkflowHandler } from "./context.js";
import { runDecisionLoop, type DecisionResult } from "./decision-loop.js";
import type { LiveSession } from "./live-session.js";
import type { ClockSource } from "./sources.js";

type Operation =
  | { readonly kind: "step" }
  | { readonly kind: "sleep"; readonly durationMs: number }
  | { readonly kind: "signal"; readonly name: string }
  | { readonly kind: "watch"; readonly name: string }
  | { readonly kind: "branch"; readonly name: string };

const SIGNAL_NAMES = ["a", "b"] as const;
const NUMBER_OF_CASES = 500;

const clock: ClockSource = { now: () => new Date("2026-01-01T00:00:00.000Z") };
const runStarted: WorkflowEvent = { type: "run_started", workflowType: "w", input: {} };

const signalName = fc.constantFrom(...SIGNAL_NAMES);

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.constant<Operation>({ kind: "step" }),
  fc.integer({ min: 1, max: 5000 }).map<Operation>((durationMs) => ({ kind: "sleep", durationMs })),
  signalName.map<Operation>((name) => ({ kind: "signal", name })),
  signalName.map<Operation>((name) => ({ kind: "watch", name })),
  signalName.map<Operation>((name) => ({ kind: "branch", name })),
);

const program = fc.array(operation, { minLength: 1, maxLength: 8 });
const picks = fc.array(fc.nat(), { minLength: 4, maxLength: 40 });

function buildHandler(operations: readonly Operation[]): WorkflowHandler {
  return async (ctx) => {
    const watched = new Set<string>();
    const trace: unknown[] = [];
    for (const [index, step] of operations.entries()) {
      switch (step.kind) {
        case "step":
          trace.push(await ctx.step("work", { index }));
          break;
        case "sleep":
          await ctx.sleep(step.durationMs);
          break;
        case "signal":
          trace.push(await ctx.waitForSignal(step.name));
          break;
        case "watch":
          void ctx.waitForSignal(step.name).then(() => watched.add(step.name));
          break;
        case "branch":
          trace.push(await ctx.step(watched.has(step.name) ? "seen" : "unseen", { index }));
          break;
      }
    }
    return trace;
  };
}

function externalEvents(history: readonly WorkflowEvent[], pick: number): WorkflowEvent[] {
  const finishedSteps = new Set<string>();
  const firedTimers = new Set<string>();
  for (const event of history) {
    if (event.type === "step_completed" || event.type === "step_failed") {
      finishedSteps.add(event.stepId);
    }
    if (event.type === "timer_fired") {
      firedTimers.add(event.timerId);
    }
  }
  const available: WorkflowEvent[] = [];
  for (const event of history) {
    if (event.type === "step_scheduled" && !finishedSteps.has(event.stepId)) {
      available.push({
        type: "step_completed",
        stepId: event.stepId,
        result: { ok: event.stepId },
      });
      if (pick % 5 === 0) {
        available.push({
          type: "step_failed",
          stepId: event.stepId,
          error: { name: "Error", message: "boom" },
        });
      }
    }
    if (event.type === "timer_started" && !firedTimers.has(event.timerId)) {
      available.push({ type: "timer_fired", timerId: event.timerId });
    }
  }
  for (const name of SIGNAL_NAMES) {
    available.push({ type: "signal_received", signalName: name, payload: { name } });
  }
  return available;
}

function sameDecision(actual: DecisionResult, expected: DecisionResult): void {
  expect(actual.outcome).toBe(expected.outcome);
  expect(actual.commands).toEqual(expected.commands);
}

function newDecider() {
  return createStickyDecider({
    cache: createRunCache<LiveSession>({ maxRuns: 4, stickyTimeoutMs: 60_000 }),
    decisionOptions: { clock },
  });
}

let cacheHits = 0;

async function replayEquivalence(
  operations: readonly Operation[],
  choices: readonly number[],
): Promise<void> {
  const handler = buildHandler(operations);
  const options = { clock, runId: "run-1", triggeredAt: new Date(clock.now()) };
  const history: WorkflowEvent[] = [runStarted];
  const decider = newDecider();

  async function decideAllWays(): Promise<DecisionResult> {
    const cold = await runDecisionLoop(handler, {}, history, options);
    const sticky = await decider.decide("run-1", handler, {}, history, options.triggeredAt);
    sameDecision(sticky.decision, cold);
    return cold;
  }

  let decision = await decideAllWays();
  history.push(...decision.commands.map(commandToEvent));
  for (const choice of choices) {
    if (decision.outcome !== "suspended") {
      break;
    }
    const available = externalEvents(history, choice);
    const first = available[choice % available.length];
    const second = available[Math.floor(choice / 7) % available.length];
    if (first === undefined || second === undefined) {
      break;
    }
    history.push(first);
    if (choice % 3 === 0 && second.type === "signal_received") {
      history.push(second);
    }
    decision = await decideAllWays();
    history.push(...decision.commands.map(commandToEvent));
  }

  cacheHits += decider.stats().cacheHits;
  const freshCold = await runDecisionLoop(handler, {}, history, options);
  const freshSticky = await newDecider().decide("run-1", handler, {}, history, options.triggeredAt);
  sameDecision(freshSticky.decision, freshCold);
  const repeated = freshCold.commands.filter(
    (command) => command.type === "schedule_step" || command.type === "start_timer",
  );
  expect(repeated).toEqual([]);
}

describe("replay equivalence", () => {
  it(`agrees between the cold replay, the incremental session and a fresh session in ${String(NUMBER_OF_CASES)} generated runs`, async () => {
    await fc.assert(fc.asyncProperty(program, picks, replayEquivalence), {
      numRuns: NUMBER_OF_CASES,
    });
    expect(cacheHits).toBeGreaterThan(0);
  }, 300_000);

  it("agrees on a run where a watched signal arrives between two steps", async () => {
    const operations: Operation[] = [
      { kind: "watch", name: "a" },
      { kind: "step" },
      { kind: "branch", name: "a" },
    ];
    await replayEquivalence(operations, [0, 3, 0, 1, 2, 4]);
  });

  it("agrees on a run whose signal arrives before it is awaited", async () => {
    const operations: Operation[] = [
      { kind: "sleep", durationMs: 10 },
      { kind: "signal", name: "b" },
    ];
    await replayEquivalence(operations, [3, 0, 0, 1, 1]);
  });
});
