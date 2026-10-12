import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import { createRunCache } from "../sticky/run-cache.js";
import { createStickyDecider } from "../sticky/sticky-decider.js";
import { commandToEvent } from "../workflow/command-events.js";
import {
  runDecisionLoop,
  type DecisionLoopOptions,
  type DecisionResult,
} from "../workflow/decision-loop.js";
import { defineWorkflow } from "../workflow/define-workflow.js";
import { VersionMismatchError } from "../workflow/errors.js";
import type { LiveSession } from "../workflow/live-session.js";

const base: DecisionLoopOptions = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const v1 = defineWorkflow("onboarding", async (ctx) => {
  await ctx.step("create-account", {});
  await ctx.step("send-welcome", {});
  return "welcomed";
});

const v2 = defineWorkflow("onboarding", async (ctx) => {
  await ctx.step("create-account", {});
  if (ctx.patched("verify-email")) {
    await ctx.step("verify-email", {});
  }
  await ctx.step("send-welcome", {});
  return "welcomed";
});

describe("workflow versioning against postgres", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let taskCounter: number;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    taskCounter = 0;
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from step_results");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from namespaces");
    await database.pool.query("insert into namespaces (name) values ('default')");
  });

  async function startRun(): Promise<string> {
    const namespace = await database.pool.query<{ id: string }>("select id from namespaces");
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'onboarding') returning id",
      [namespace.rows[0]?.id],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "onboarding", input: {} }]);
    return runId;
  }

  async function history(runId: string): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function decideWith(
    handler: typeof v1.handler,
    runId: string,
    buildId: string,
  ): Promise<DecisionResult> {
    const events = await history(runId);
    const decision = await runDecisionLoop(handler, {}, events, { ...base, buildId });
    taskCounter += 1;
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `task-${String(taskCounter)}`,
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    });
    return decision;
  }

  async function finishStep(runId: string, stepId: string): Promise<void> {
    const events = await history(runId);
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `result-${stepId}`,
      expectedSeq: events.length,
      events: [{ type: "step_completed", stepId, result: null }],
    });
  }

  it("finishes a run that started on v1 after v2 is deployed, without the new step", async () => {
    const runId = await startRun();
    await decideWith(v1.handler, runId, "build-1");
    await finishStep(runId, "step-1");
    await decideWith(v1.handler, runId, "build-1");

    const afterUpgrade = await decideWith(v2.handler, runId, "build-2");
    expect(afterUpgrade).toEqual({ outcome: "suspended", commands: [] });
    await finishStep(runId, "step-2");
    const last = await decideWith(v2.handler, runId, "build-2");

    expect(last).toMatchObject({ outcome: "completed", result: "welcomed" });
    const types = (await history(runId)).map((event) => event.type);
    expect(types).not.toContain("patch_recorded");
    expect(types.filter((type) => type === "step_scheduled")).toHaveLength(2);
  });

  it("sends a new run down the v2 branch and stamps the build id on the patch event", async () => {
    const runId = await startRun();
    await decideWith(v2.handler, runId, "build-2");
    await finishStep(runId, "step-1");
    await decideWith(v2.handler, runId, "build-2");

    const events = await history(runId);
    expect(events.find((event) => event.type === "patch_recorded")).toEqual({
      type: "patch_recorded",
      patchId: "verify-email",
      buildId: "build-2",
    });
    const scheduled = events.flatMap((event) =>
      event.type === "step_scheduled" ? [event.stepType] : [],
    );
    expect(scheduled).toEqual(["create-account", "verify-email"]);
  });

  it("makes a stale v1 worker refuse a run that v2 already patched", async () => {
    const runId = await startRun();
    await decideWith(v2.handler, runId, "build-2");
    await finishStep(runId, "step-1");
    await decideWith(v2.handler, runId, "build-2");

    const events = await history(runId);
    const refusal = await runDecisionLoop(v1.handler, {}, events, {
      ...base,
      buildId: "build-1",
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(VersionMismatchError);
    expect((await history(runId)).length).toBe(events.length);
  });

  it("keeps the recorded patch event when the same workflow task is delivered twice", async () => {
    const runId = await startRun();
    await decideWith(v2.handler, runId, "build-2");
    await finishStep(runId, "step-1");
    const events = await history(runId);
    const decision = await runDecisionLoop(v2.handler, {}, events, { ...base, buildId: "b" });
    const input = {
      runId,
      taskKey: "same-task",
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    };
    await Promise.all([
      recorder.recordWorkflowTaskResult(input),
      recorder.recordWorkflowTaskResult(input),
    ]);
    const patches = (await history(runId)).filter((event) => event.type === "patch_recorded");
    expect(patches).toHaveLength(1);
  });

  it("decides a patched workflow through the sticky cache exactly as a full replay does", async () => {
    const decider = createStickyDecider({
      cache: createRunCache<LiveSession>({ maxRuns: 4, stickyTimeoutMs: 60_000 }),
      decisionOptions: { ...base, buildId: "build-2" },
    });
    const runId = await startRun();
    for (let round = 0; round < 4; round += 1) {
      const events = await history(runId);
      const sticky = await decider.decide(runId, v2.handler, {}, events);
      const replayed = await runDecisionLoop(v2.handler, {}, events, {
        ...base,
        buildId: "build-2",
      });
      expect(sticky.decision).toEqual(replayed);
      taskCounter += 1;
      await recorder.recordWorkflowTaskResult({
        runId,
        taskKey: `sticky-${String(taskCounter)}`,
        expectedSeq: events.length,
        events: sticky.decision.commands.map(commandToEvent),
      });
      const next = (await history(runId)).flatMap((event) =>
        event.type === "step_scheduled" ? [event.stepId] : [],
      );
      const pending = next.at(-1);
      if (pending !== undefined) {
        await finishStep(runId, pending);
      }
    }
    const types = (await history(runId)).map((event) => event.type);
    expect(types).toContain("patch_recorded");
    expect(types).toContain("run_completed");
  });
});
