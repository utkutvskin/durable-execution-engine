import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { commandToEvent } from "../workflow/command-events.js";
import type { WorkflowHandler } from "../workflow/context.js";
import {
  runDecisionLoop,
  type DecisionLoopOptions,
  type DecisionResult,
} from "../workflow/decision-loop.js";
import { NonDeterminismError } from "../workflow/errors.js";
import type { LiveSession } from "../workflow/live-session.js";
import { createRunCache } from "./run-cache.js";
import { createStickyDecider, type StickyDecider } from "./sticky-decider.js";

const options: DecisionLoopOptions = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const RUN = "run-1";

function newDecider(maxRuns = 16): StickyDecider {
  return createStickyDecider({
    cache: createRunCache<LiveSession>({ maxRuns, stickyTimeoutMs: 60_000 }),
    decisionOptions: options,
  });
}

function started(workflowType: string, input: unknown): WorkflowEvent {
  return { type: "run_started", workflowType, input };
}

const chain: WorkflowHandler<{ steps: number }, number> = async (ctx, input) => {
  let total = 0;
  for (let index = 0; index < input.steps; index += 1) {
    total += await ctx.step<number>("add", { index });
  }
  return total;
};

interface DrivenRun {
  readonly decisions: DecisionResult[];
  readonly history: WorkflowEvent[];
}

async function drive<TInput, TResult>(
  decider: StickyDecider | undefined,
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  resultOf: (command: { stepId: string; input: unknown }) => unknown,
  onTurn?: (turn: number) => void,
): Promise<DrivenRun> {
  const history: WorkflowEvent[] = [started("w", input)];
  const decisions: DecisionResult[] = [];
  for (let turn = 0; turn < 1000; turn += 1) {
    onTurn?.(turn);
    const decision =
      decider === undefined
        ? await runDecisionLoop(handler, input, history, options)
        : (await decider.decide(RUN, handler, input, history)).decision;
    decisions.push(decision);
    history.push(...decision.commands.map(commandToEvent));
    if (decision.outcome !== "suspended") {
      break;
    }
    for (const command of decision.commands) {
      if (command.type === "schedule_step") {
        history.push({
          type: "step_completed",
          stepId: command.stepId,
          result: resultOf({ stepId: command.stepId, input: command.input }),
        });
      }
    }
  }
  return { decisions, history };
}

const indexOf = (command: { input: unknown }): unknown =>
  (command.input as { index: number }).index;

describe("sticky decider", () => {
  it("decides every task of a 40 step run exactly as a full replay does", async () => {
    const plain = await drive(undefined, chain, { steps: 40 }, indexOf);
    const sticky = await drive(newDecider(), chain, { steps: 40 }, indexOf);
    expect(sticky.decisions).toEqual(plain.decisions);
    expect(sticky.history).toEqual(plain.history);
  });

  it("replays once and serves every later task from the cache", async () => {
    const decider = newDecider();
    await drive(decider, chain, { steps: 30 }, indexOf);
    const stats = decider.stats();
    expect(stats.fullReplays).toBe(1);
    expect(stats.cacheHits).toBe(30);
    expect(stats.cacheMisses).toBe(1);
  });

  it("cuts the replays of a 500 step workflow by at least 80 percent", async () => {
    let offReplays = 0;
    const offRun = await drive(undefined, chain, { steps: 500 }, indexOf, () => {
      offReplays += 1;
    });
    const on = newDecider();
    const onRun = await drive(on, chain, { steps: 500 }, indexOf);
    expect(onRun.decisions.at(-1)).toEqual(offRun.decisions.at(-1));
    expect(offReplays).toBe(501);
    expect(on.stats().fullReplays).toBeLessThanOrEqual(offReplays * 0.2);
    expect(on.stats().replayedEvents).toBeLessThan(offReplays);
    expect(on.stats().incrementalEvents).toBeGreaterThan(900);
  });

  it("does not change the result when the cache is flushed on every third task", async () => {
    const plain = await drive(undefined, chain, { steps: 60 }, indexOf);
    const decider = newDecider();
    const flushed = await drive(decider, chain, { steps: 60 }, indexOf, (turn) => {
      if (turn % 3 === 0) {
        decider.flush();
      }
    });
    expect(flushed.decisions).toEqual(plain.decisions);
    expect(decider.stats().fullReplays).toBeGreaterThan(15);
    expect(flushed.decisions.at(-1)).toMatchObject({ outcome: "completed", result: 1770 });
  });

  it("falls back to a full replay when the previous commands were never recorded", async () => {
    const decider = newDecider();
    const history = [started("w", { steps: 3 })];
    const first = await decider.decide(RUN, chain, { steps: 3 }, history);
    expect(first.decision.commands).toHaveLength(1);
    const second = await decider.decide(RUN, chain, { steps: 3 }, history);
    expect(second.source).toBe("replay");
    expect(second.decision.commands).toEqual(first.decision.commands);
    expect(decider.stats().invalidations).toBe(1);
  });

  it("falls back to a full replay when the history no longer continues the session", async () => {
    const decider = newDecider();
    const history: WorkflowEvent[] = [started("w", { steps: 3 })];
    const first = await decider.decide(RUN, chain, { steps: 3 }, history);
    history.push(...first.decision.commands.map(commandToEvent));
    const rewritten: WorkflowEvent[] = [started("w", { steps: 2 }), ...history.slice(1)];
    const second = await decider.decide(RUN, chain, { steps: 3 }, rewritten);
    expect(second.source).toBe("replay");
    expect(second.decision).toEqual(await runDecisionLoop(chain, { steps: 3 }, rewritten, options));
  });

  it("drops the session once the run completes", async () => {
    const decider = newDecider();
    const finished = await drive(decider, chain, { steps: 2 }, indexOf);
    expect(finished.decisions.at(-1)?.outcome).toBe("completed");
    const again = await decider.decide(RUN, chain, { steps: 2 }, finished.history);
    expect(again.source).toBe("replay");
  });

  it("serves timers and signals incrementally", async () => {
    const waiting: WorkflowHandler<null, string> = async (ctx) => {
      await ctx.sleep(1000);
      const approval = await ctx.waitForSignal<string>("approve");
      const second = await ctx.waitForSignal<string>("approve");
      return `${approval}+${second}`;
    };
    const decider = newDecider();
    const history: WorkflowEvent[] = [started("w", null)];
    const turn = async (): Promise<DecisionResult> => {
      const { decision } = await decider.decide(RUN, waiting, null, history);
      history.push(...decision.commands.map(commandToEvent));
      return decision;
    };
    const first = await turn();
    expect(first.commands).toEqual([
      {
        type: "start_timer",
        timerId: "timer-1",
        fireAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
      },
    ]);
    history.push({ type: "signal_received", signalName: "approve", payload: "a" });
    expect((await turn()).outcome).toBe("suspended");
    history.push({ type: "timer_fired", timerId: "timer-1" });
    expect((await turn()).outcome).toBe("suspended");
    history.push({ type: "signal_received", signalName: "approve", payload: "b" });
    expect(await turn()).toMatchObject({ outcome: "completed", result: "a+b" });
    expect(decider.stats().fullReplays).toBe(1);
  });

  it("matches a full replay for a workflow that fans out with ctx.all and never caches it", async () => {
    const fanOut: WorkflowHandler<null, number[]> = (ctx) =>
      ctx.all([() => ctx.step<number>("a", 1), () => ctx.step<number>("b", 2)]);
    const decider = newDecider();
    const history: WorkflowEvent[] = [started("w", null)];
    const first = await decider.decide(RUN, fanOut, null, history);
    expect(first.decision).toEqual(await runDecisionLoop(fanOut, null, history, options));
    history.push(...first.decision.commands.map(commandToEvent));
    history.push({ type: "step_completed", stepId: "step-1", result: 10 });
    history.push({ type: "step_completed", stepId: "step-2", result: 20 });
    const second = await decider.decide(RUN, fanOut, null, history);
    expect(second.source).toBe("replay");
    expect(second.decision).toMatchObject({ outcome: "completed", result: [10, 20] });
    expect(decider.stats().cacheHits).toBe(0);
  });

  it("raises a non-determinism error from a cached session and drops it", async () => {
    const decider = newDecider();
    const history: WorkflowEvent[] = [started("w", { steps: 3 })];
    const first = await decider.decide(RUN, chain, { steps: 3 }, history);
    history.push(...first.decision.commands.map(commandToEvent));
    history.push({ type: "step_completed", stepId: "step-1", result: 0 });
    history.push({
      type: "step_scheduled",
      stepId: "step-2",
      stepType: "other",
      input: { index: 1 },
    });
    await expect(decider.decide(RUN, chain, { steps: 3 }, history)).rejects.toBeInstanceOf(
      NonDeterminismError,
    );
    await expect(decider.decide(RUN, chain, { steps: 3 }, history)).rejects.toBeInstanceOf(
      NonDeterminismError,
    );
  });

  it("expires a cached session after the sticky timeout and replays instead", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const decider = createStickyDecider({
      cache: createRunCache<LiveSession>({
        maxRuns: 4,
        stickyTimeoutMs: 5000,
        clock: { now: () => new Date(now) },
      }),
      decisionOptions: options,
    });
    const history: WorkflowEvent[] = [started("w", { steps: 3 })];
    const first = await decider.decide(RUN, chain, { steps: 3 }, history);
    history.push(...first.decision.commands.map(commandToEvent));
    history.push({ type: "step_completed", stepId: "step-1", result: 0 });
    now += 5001;
    const second = await decider.decide(RUN, chain, { steps: 3 }, history);
    expect(second.source).toBe("replay");
    expect(second.decision).toEqual(await runDecisionLoop(chain, { steps: 3 }, history, options));
  });

  it("keeps runs apart and evicts the least recently used session", async () => {
    const decider = newDecider(2);
    const histories = ["run-a", "run-b", "run-c"].map((id) => ({
      id,
      history: [started("w", { steps: 3 })] as WorkflowEvent[],
    }));
    for (const { id, history } of histories) {
      await decider.decide(id, chain, { steps: 3 }, history);
    }
    const evicted = histories[0];
    const kept = histories[2];
    if (evicted === undefined || kept === undefined) {
      throw new Error("missing history");
    }
    const evictedAgain = await decider.decide(evicted.id, chain, { steps: 3 }, evicted.history);
    expect(evictedAgain.source).toBe("replay");
    kept.history.push({
      type: "step_scheduled",
      stepId: "step-1",
      stepType: "add",
      input: { index: 0 },
    });
    const keptAgain = await decider.decide(kept.id, chain, { steps: 3 }, kept.history);
    expect(keptAgain.source).toBe("cache");
  });

  it("rejects a workflow that reads the clock directly while cached", async () => {
    const forbidden: WorkflowHandler<null, number> = async (ctx) => {
      await ctx.step("a", null);
      return Date.now();
    };
    const decider = newDecider();
    const history: WorkflowEvent[] = [started("w", null)];
    const first = await decider.decide(RUN, forbidden, null, history);
    history.push(...first.decision.commands.map(commandToEvent));
    history.push({ type: "step_completed", stepId: "step-1", result: 1 });
    await expect(decider.decide(RUN, forbidden, null, history)).rejects.toMatchObject({
      name: "ForbiddenApiError",
    });
  });
});
