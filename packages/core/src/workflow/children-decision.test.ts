import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { runDecisionLoop } from "./decision-loop.js";
import { defineWorkflow } from "./define-workflow.js";
import { ChildLimitExceededError, NonDeterminismError } from "./errors.js";
import type { ClockSource, RandomSource } from "./sources.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const started: WorkflowEvent = { type: "run_started", workflowType: "parent", input: {} };

function childStarted(index: number, input: unknown = { index }): WorkflowEvent {
  return {
    type: "child_started",
    childId: `child-${String(index)}`,
    workflowType: "square",
    input,
    parentClosePolicy: "cancel",
  };
}

function childDone(index: number, result: unknown): WorkflowEvent {
  return { type: "child_completed", childId: `child-${String(index)}`, result };
}

function childFailed(index: number, message: string): WorkflowEvent {
  return {
    type: "child_failed",
    childId: `child-${String(index)}`,
    error: { name: "Error", message },
  };
}

function startCommand(index: number) {
  return {
    type: "start_child",
    childId: `child-${String(index)}`,
    workflowType: "square",
    input: { index },
    parentClosePolicy: "cancel",
  };
}

const fanOut = defineWorkflow(
  "fan-out",
  async (ctx, input: { count: number; concurrency?: number }) => {
    const tasks = Array.from(
      { length: input.count },
      (_, index) => () => ctx.executeChild<number>("square", { index: index + 1 }),
    );
    const results = await ctx.all(
      tasks,
      input.concurrency === undefined ? undefined : { concurrency: input.concurrency },
    );
    return results.reduce((total, value) => total + value, 0);
  },
);

describe("child workflows in the decision loop", () => {
  it("starts a child with the cancel policy by default and waits for it", async () => {
    const parent = defineWorkflow("parent", async (ctx) =>
      ctx.executeChild("square", { index: 1 }),
    );

    const decision = await runDecisionLoop(parent.handler, {}, [started], sources);

    expect(decision).toEqual({ outcome: "suspended", commands: [startCommand(1)] });
  });

  it("records the requested parent close policy in the command", async () => {
    const parent = defineWorkflow("parent", (ctx) => {
      ctx.startChild("square", { index: 1 }, { parentClosePolicy: "abandon" });
      return Promise.resolve("started");
    });

    const decision = await runDecisionLoop(parent.handler, {}, [started], sources);

    expect(decision.commands[0]).toEqual({ ...startCommand(1), parentClosePolicy: "abandon" });
    expect(decision.outcome).toBe("completed");
  });

  it("resolves a child's result from the history without starting it again", async () => {
    const parent = defineWorkflow("parent", async (ctx) =>
      ctx.executeChild("square", { index: 1 }),
    );

    const decision = await runDecisionLoop(
      parent.handler,
      {},
      [started, childStarted(1), childDone(1, 1)],
      sources,
    );

    expect(decision).toEqual({
      outcome: "completed",
      result: 1,
      commands: [{ type: "complete_run", result: 1 }],
    });
  });

  it("rejects the parent's wait when the child failed and lets the workflow catch it", async () => {
    const parent = defineWorkflow("parent", async (ctx) => {
      try {
        return await ctx.executeChild("square", { index: 1 });
      } catch (error: unknown) {
        return `recovered: ${(error as Error).message}`;
      }
    });

    const decision = await runDecisionLoop(
      parent.handler,
      {},
      [started, childStarted(1), childFailed(1, "boom")],
      sources,
    );

    expect(decision).toMatchObject({ outcome: "completed", result: "recovered: boom" });
  });

  it("does not fail a parent that ignores a failed child it never awaited", async () => {
    const parent = defineWorkflow("parent", (ctx) => {
      ctx.startChild("square", { index: 1 }, { parentClosePolicy: "abandon" });
      return Promise.resolve("done");
    });

    const decision = await runDecisionLoop(
      parent.handler,
      {},
      [started, childStarted(1), childFailed(1, "boom")],
      sources,
    );

    expect(decision).toMatchObject({ outcome: "completed", result: "done" });
  });

  it("starts every child of ctx.all at once and aggregates in task order", async () => {
    const first = await runDecisionLoop(fanOut.handler, { count: 5 }, [started], sources);
    expect(first.commands).toEqual([1, 2, 3, 4, 5].map(startCommand));

    const history: WorkflowEvent[] = [
      started,
      ...[1, 2, 3, 4, 5].map((index) => childStarted(index)),
      childDone(3, 9),
      childDone(1, 1),
      childDone(5, 25),
      childDone(2, 4),
      childDone(4, 16),
    ];
    const finished = await runDecisionLoop(fanOut.handler, { count: 5 }, history, sources);
    expect(finished).toMatchObject({ outcome: "completed", result: 55 });
  });

  it("rejects ctx.all with the error of the child that failed first in the history", async () => {
    const parent = defineWorkflow("parent", async (ctx) =>
      ctx.all([1, 2, 3].map((index) => () => ctx.executeChild("square", { index }))),
    );

    const decision = await runDecisionLoop(
      parent.handler,
      {},
      [
        started,
        ...[1, 2, 3].map((index) => childStarted(index)),
        childDone(1, 1),
        childFailed(3, "third failed"),
        childFailed(2, "second failed"),
      ],
      sources,
    );

    expect(decision).toMatchObject({ outcome: "failed" });
    expect(decision.outcome === "failed" && decision.error.message).toBe("third failed");
  });

  it("settles every child with ctx.allSettled, failures included", async () => {
    const parent = defineWorkflow("parent", async (ctx) => {
      const outcomes = await ctx.allSettled(
        [1, 2].map((index) => () => ctx.executeChild<number>("square", { index })),
      );
      return outcomes.map((outcome) => outcome.status);
    });

    const decision = await runDecisionLoop(
      parent.handler,
      {},
      [started, childStarted(1), childStarted(2), childFailed(2, "no"), childDone(1, 1)],
      sources,
    );

    expect(decision).toMatchObject({ outcome: "completed", result: ["fulfilled", "rejected"] });
  });

  it("holds back tasks beyond the concurrency limit until a child finishes", async () => {
    const first = await runDecisionLoop(
      fanOut.handler,
      { count: 6, concurrency: 2 },
      [started],
      sources,
    );
    expect(first.commands).toEqual([startCommand(1), startCommand(2)]);

    const afterSecond = await runDecisionLoop(
      fanOut.handler,
      { count: 6, concurrency: 2 },
      [started, childStarted(1), childStarted(2), childDone(2, 4)],
      sources,
    );
    expect(afterSecond.commands).toEqual([startCommand(3)]);
  });

  it("starts the same children on every concurrent replay of a bounded fan-out", async () => {
    const history: WorkflowEvent[] = [
      started,
      childStarted(1),
      childStarted(2),
      childStarted(3),
      childDone(3, 9),
      childDone(1, 1),
      childStarted(4),
      childStarted(5),
      childDone(4, 16),
    ];

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        runDecisionLoop(fanOut.handler, { count: 8, concurrency: 3 }, history, sources),
      ),
    );

    for (const decision of decisions) {
      expect(decision.commands).toEqual(decisions[0]?.commands);
    }
    expect(decisions[0]?.commands).toEqual([startCommand(6)]);
  });

  it("fails the run with ChildLimitExceededError past the child limit", async () => {
    const decision = await runDecisionLoop(fanOut.handler, { count: 4 }, [started], {
      ...sources,
      maxChildren: 3,
    });

    expect(decision.outcome).toBe("failed");
    expect(decision.outcome === "failed" && decision.error).toBeInstanceOf(ChildLimitExceededError);
  });

  it("rejects a non-positive concurrency", async () => {
    const decision = await runDecisionLoop(
      fanOut.handler,
      { count: 2, concurrency: 0 },
      [started],
      sources,
    );

    expect(decision.outcome).toBe("failed");
    expect(decision.outcome === "failed" && decision.error).toBeInstanceOf(RangeError);
  });

  it("detects a child whose type or input no longer matches the history", async () => {
    const parent = defineWorkflow("parent", async (ctx) =>
      ctx.executeChild("square", { index: 2 }),
    );

    await expect(
      runDecisionLoop(parent.handler, {}, [started, childStarted(1, { index: 1 })], sources),
    ).rejects.toBeInstanceOf(NonDeterminismError);
  });

  it("rejects a pending child wait with CancelledError once cancellation was requested", async () => {
    const parent = defineWorkflow("parent", async (ctx) => {
      ctx.onCancel(async (compensation) => {
        await compensation.step("cleanup", {});
      });
      return ctx.executeChild("square", { index: 1 });
    });

    const decision = await runDecisionLoop(
      parent.handler,
      {},
      [started, childStarted(1), { type: "cancel_requested", reason: "stop" }],
      sources,
    );

    expect(decision).toEqual({
      outcome: "suspended",
      commands: [{ type: "schedule_step", stepId: "step-1", stepType: "cleanup", input: {} }],
    });
  });
});
