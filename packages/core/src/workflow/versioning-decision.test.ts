import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.js";
import { commandToEvent } from "./command-events.js";
import { runDecisionLoop } from "./decision-loop.js";
import { defineWorkflow } from "./define-workflow.js";
import { VersionMismatchError } from "./errors.js";
import { runQuery } from "./query.js";
import type { ClockSource, RandomSource } from "./sources.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const started: WorkflowEvent = { type: "run_started", workflowType: "billing", input: {} };

const v1 = defineWorkflow("billing", async (ctx) => {
  await ctx.step("invoice", {});
  await ctx.step("charge", {});
  return "done";
});

const v2 = defineWorkflow("billing", async (ctx) => {
  await ctx.step("invoice", {});
  if (ctx.patched("tax")) {
    await ctx.step("tax", {});
  }
  await ctx.step("charge", {});
  return "done";
});

const v3 = defineWorkflow("billing", async (ctx) => {
  await ctx.step("invoice", {});
  ctx.deprecatePatch("tax");
  await ctx.step("tax", {});
  await ctx.step("charge", {});
  return "done";
});

const invoiceDone: WorkflowEvent[] = [
  { type: "step_scheduled", stepId: "step-1", stepType: "invoice", input: {} },
  { type: "step_completed", stepId: "step-1", result: null },
];

describe("workflow versioning", () => {
  it("takes the new branch on a fresh run and records the patch before the new step", async () => {
    const result = await runDecisionLoop(v2.handler, {}, [started, ...invoiceDone], {
      ...sources,
      buildId: "build-2",
    });
    expect(result.commands).toEqual([
      { type: "record_patch", patchId: "tax", buildId: "build-2" },
      { type: "schedule_step", stepId: "step-2", stepType: "tax", input: {} },
    ]);
  });

  it("keeps the old branch for a run whose history moved past the gate on v1", async () => {
    const history: WorkflowEvent[] = [
      started,
      ...invoiceDone,
      { type: "step_scheduled", stepId: "step-2", stepType: "charge", input: {} },
    ];
    const result = await runDecisionLoop(v2.handler, {}, history, sources);
    expect(result).toEqual({ outcome: "suspended", commands: [] });
  });

  it("completes a v1 run that is half finished without a non-determinism error", async () => {
    const history: WorkflowEvent[] = [
      started,
      ...invoiceDone,
      { type: "step_scheduled", stepId: "step-2", stepType: "charge", input: {} },
      { type: "step_completed", stepId: "step-2", result: null },
    ];
    const result = await runDecisionLoop(v2.handler, {}, history, sources);
    expect(result).toMatchObject({ outcome: "completed", result: "done" });
  });

  it("replays a recorded patch as the new branch on every replay", async () => {
    const history: WorkflowEvent[] = [
      started,
      ...invoiceDone,
      { type: "patch_recorded", patchId: "tax", buildId: "build-2" },
      { type: "step_scheduled", stepId: "step-2", stepType: "tax", input: {} },
    ];
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => runDecisionLoop(v2.handler, {}, history, sources)),
    );
    for (const decision of decisions) {
      expect(decision).toEqual({ outcome: "suspended", commands: [] });
    }
  });

  it("answers the same for every call of one patch id within a replay", async () => {
    const looping = defineWorkflow("loop", async (ctx) => {
      const answers: boolean[] = [];
      for (let index = 0; index < 3; index += 1) {
        answers.push(ctx.patched("loop-patch"));
        await ctx.step("tick", index);
      }
      return answers;
    });
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "loop", input: {} },
      { type: "step_scheduled", stepId: "step-1", stepType: "tick", input: 0 },
      { type: "step_completed", stepId: "step-1", result: null },
      { type: "step_scheduled", stepId: "step-2", stepType: "tick", input: 1 },
      { type: "step_completed", stepId: "step-2", result: null },
      { type: "step_scheduled", stepId: "step-3", stepType: "tick", input: 2 },
      { type: "step_completed", stepId: "step-3", result: null },
    ];
    const result = await runDecisionLoop(looping.handler, {}, history, sources);
    expect(result).toMatchObject({ outcome: "completed", result: [false, false, false] });
  });

  it("records a patch only once per replay however often it is asked", async () => {
    const asking = defineWorkflow("asking", async (ctx) => {
      await ctx.step("noop", {});
      const first = ctx.patched("once");
      const second = ctx.patched("once");
      ctx.deprecatePatch("once");
      return [first, second];
    });
    const result = await runDecisionLoop(
      asking.handler,
      {},
      [
        { type: "run_started", workflowType: "asking", input: {} },
        { type: "step_scheduled", stepId: "step-1", stepType: "noop", input: {} },
        { type: "step_completed", stepId: "step-1", result: null },
      ],
      sources,
    );
    expect(result.commands.filter((command) => command.type === "record_patch")).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "completed", result: [true, true] });
  });

  it("lets deprecated code replay a run that recorded the patch", async () => {
    const history: WorkflowEvent[] = [
      started,
      ...invoiceDone,
      { type: "patch_recorded", patchId: "tax" },
      { type: "step_scheduled", stepId: "step-2", stepType: "tax", input: {} },
      { type: "step_completed", stepId: "step-2", result: null },
    ];
    const result = await runDecisionLoop(v3.handler, {}, history, sources);
    expect(result).toEqual({
      outcome: "suspended",
      commands: [{ type: "schedule_step", stepId: "step-3", stepType: "charge", input: {} }],
    });
  });

  it("turns a record_patch command into a patch_recorded event carrying the build id", () => {
    expect(commandToEvent({ type: "record_patch", patchId: "tax", buildId: "build-2" })).toEqual({
      type: "patch_recorded",
      patchId: "tax",
      buildId: "build-2",
    });
    expect(commandToEvent({ type: "record_patch", patchId: "tax" })).toEqual({
      type: "patch_recorded",
      patchId: "tax",
    });
  });

  it("rejects a history patched by a newer build instead of deciding on old code", async () => {
    const history: WorkflowEvent[] = [
      started,
      ...invoiceDone,
      { type: "patch_recorded", patchId: "tax", buildId: "build-2" },
      { type: "step_scheduled", stepId: "step-2", stepType: "tax", input: {} },
    ];
    const rejection = await runDecisionLoop(v1.handler, {}, history, {
      ...sources,
      buildId: "build-1",
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(VersionMismatchError);
    expect(rejection).toMatchObject({
      patchIds: ["tax"],
      recordedBy: ["build-2"],
      buildId: "build-1",
    });
    expect((rejection as Error).message).toContain("build-2");
  });

  it("refuses a query on a history the code is too old for", async () => {
    const history: WorkflowEvent[] = [
      started,
      { type: "patch_recorded", patchId: "tax", buildId: "build-2" },
    ];
    await expect(runQuery(v1.handler, {}, history, sources, "status")).rejects.toBeInstanceOf(
      VersionMismatchError,
    );
  });
});
