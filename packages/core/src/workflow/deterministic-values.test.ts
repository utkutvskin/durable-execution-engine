import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { createRunCache } from "../sticky/run-cache.js";
import { createStickyDecider } from "../sticky/sticky-decider.js";
import { commandToEvent } from "./command-events.js";
import type { WorkflowHandler } from "./context.js";
import { runDecisionLoop, type DecisionResult } from "./decision-loop.js";
import { NonDeterminismError } from "./errors.js";
import type { LiveSession } from "./live-session.js";
import { systemClock } from "./sources.js";

type Mode = "cold" | "sticky";

interface Driven {
  readonly decisions: DecisionResult[];
  readonly history: WorkflowEvent[];
}

async function drive(
  mode: Mode,
  handler: WorkflowHandler,
  runId: string,
  input: unknown = {},
): Promise<Driven> {
  const history: WorkflowEvent[] = [{ type: "run_started", workflowType: "w", input }];
  const decisions: DecisionResult[] = [];
  const decider = createStickyDecider({
    cache: createRunCache<LiveSession>({ maxRuns: 4, stickyTimeoutMs: 60_000 }),
    decisionOptions: { clock: systemClock },
  });
  for (let turn = 0; turn < 50; turn += 1) {
    const triggeredAt = new Date();
    const decision =
      mode === "cold"
        ? await runDecisionLoop(handler, input, history, { clock: systemClock, runId, triggeredAt })
        : (await decider.decide(runId, handler, input, history, triggeredAt)).decision;
    decisions.push(decision);
    history.push(...decision.commands.map(commandToEvent));
    if (decision.outcome !== "suspended") {
      return { decisions, history };
    }
    for (const command of decision.commands) {
      if (command.type === "schedule_step") {
        history.push({ type: "step_completed", stepId: command.stepId, result: { ok: true } });
      }
    }
  }
  throw new Error("the run did not finish in 50 decisions");
}

const valuesIntoSteps: WorkflowHandler = async (ctx) => {
  for (let index = 0; index < 5; index += 1) {
    await ctx.step("record", {
      index,
      id: ctx.uuid(),
      roll: ctx.random(),
      at: ctx.now(),
    });
  }
  return "done";
};

function stepInputs(history: readonly WorkflowEvent[]): unknown[] {
  return history.flatMap((event) => (event.type === "step_scheduled" ? [event.input] : []));
}

describe.each<Mode>(["cold", "sticky"])("values read from the context on the %s path", (mode) => {
  it("feeds uuid, random and now into step inputs through five decisions", async () => {
    const { decisions, history } = await drive(mode, valuesIntoSteps, "run-values");
    expect(decisions.at(-1)?.outcome).toBe("completed");
    expect(decisions.filter((decision) => decision.outcome === "suspended")).toHaveLength(5);
    expect(stepInputs(history)).toHaveLength(5);
  });

  it("draws different uuids and random numbers on every call of one run", async () => {
    const { history } = await drive(mode, valuesIntoSteps, "run-distinct");
    const inputs = stepInputs(history) as { id: string; roll: number }[];
    expect(new Set(inputs.map((input) => input.id)).size).toBe(5);
    expect(new Set(inputs.map((input) => input.roll)).size).toBe(5);
    for (const input of inputs) {
      expect(input.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(input.roll).toBeGreaterThanOrEqual(0);
      expect(input.roll).toBeLessThan(1);
    }
  });

  it("replays inputs holding undefined, a Date, NaN and negative zero", async () => {
    const odd: WorkflowHandler = async (ctx) => {
      await ctx.step("odd", { a: undefined, at: new Date(0), nan: Number.NaN, zero: -0 });
      await ctx.step("odd", { list: [undefined, new Date(86_400_000), -0] });
      return ctx.step("odd", undefined);
    };
    const { decisions } = await drive(mode, odd, "run-odd");
    expect(decisions.at(-1)?.outcome).toBe("completed");
  });

  it("still detects a changed input after canonical encoding", async () => {
    const first: WorkflowHandler = async (ctx) => ctx.step("x", { value: 1, other: -0 });
    const { history } = await drive(mode, first, "run-changed");
    const second: WorkflowHandler = async (ctx) => ctx.step("x", { value: 2, other: -0 });
    const replayed = history.slice(0, 4);
    await expect(
      runDecisionLoop(second, {}, replayed, { clock: systemClock, runId: "run-changed" }),
    ).rejects.toBeInstanceOf(NonDeterminismError);
  });
});

describe("seeded values", () => {
  it("gives the cold and the sticky path the same uuids and random numbers for a run", async () => {
    const cold = await drive("cold", valuesIntoSteps, "run-same");
    const sticky = await drive("sticky", valuesIntoSteps, "run-same");
    const strip = (history: readonly WorkflowEvent[]): unknown[] =>
      stepInputs(history).map((input) => {
        const { id, roll } = input as { id: string; roll: number };
        return { id, roll };
      });
    expect(strip(cold.history)).toEqual(strip(sticky.history));
  });

  it("gives two runs different uuids", async () => {
    const one = await drive("cold", valuesIntoSteps, "run-one");
    const two = await drive("cold", valuesIntoSteps, "run-two");
    const ids = (history: readonly WorkflowEvent[]): unknown[] =>
      stepInputs(history).map((input) => (input as { id: string }).id);
    expect(ids(one.history)).not.toEqual(ids(two.history));
  });

  it("returns the time recorded for a call, not the clock of the replay", async () => {
    const recorded = "2026-02-03T04:05:06.000Z";
    const handler: WorkflowHandler = (ctx) => Promise.resolve(ctx.now().toISOString());
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "w", input: {} },
      { type: "time_recorded", time: recorded },
    ];
    const decision = await runDecisionLoop(handler, {}, history, {
      clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
      runId: "run-time",
    });
    expect(decision).toMatchObject({ outcome: "completed", result: recorded });
  });

  it("records the time of the triggering event when a call has no recorded time yet", async () => {
    const triggeredAt = new Date("2026-05-06T07:08:09.000Z");
    const handler: WorkflowHandler = (ctx) => Promise.resolve(ctx.now().toISOString());
    const decision = await runDecisionLoop(
      handler,
      {},
      [{ type: "run_started", workflowType: "w", input: {} }],
      { clock: { now: () => new Date("2030-01-01T00:00:00.000Z") }, runId: "r", triggeredAt },
    );
    expect(decision.commands).toContainEqual({
      type: "record_time",
      time: "2026-05-06T07:08:09.000Z",
    });
    expect(decision).toMatchObject({ outcome: "completed", result: "2026-05-06T07:08:09.000Z" });
  });
});
