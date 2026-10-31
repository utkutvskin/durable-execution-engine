import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createRunCache } from "../sticky/run-cache.js";
import { createStickyDecider } from "../sticky/sticky-decider.js";
import type { WorkflowHandler } from "../workflow/context.js";
import { runDecisionLoop, type DecisionLoopOptions } from "../workflow/decision-loop.js";
import type { LiveSession } from "../workflow/live-session.js";
import { createResultRecorder, type ResultRecorder } from "./recorder.js";

const options: DecisionLoopOptions = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const charge: WorkflowHandler<unknown, string> = async (ctx) => {
  try {
    const receipt = await ctx.step<string>("charge", { amount: 5 });
    return `paid:${receipt}`;
  } catch (error) {
    if (error instanceof Error && error.message === "declined") {
      return "declined";
    }
    throw error;
  }
};

const terminalTypes = new Set(["step_completed", "step_failed"]);

describe("one terminal result per step", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  async function startRun(): Promise<void> {
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ($1) returning id",
      [`ns-${Math.random().toString(16).slice(2)}`],
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'charge') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [
      { type: "run_started", workflowType: "charge", input: {} },
      { type: "step_scheduled", stepId: "step-1", stepType: "charge", input: { amount: 5 } },
    ]);
  }

  async function history(): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function replayBothWays(events: WorkflowEvent[]): Promise<[unknown, unknown]> {
    const cold = await runDecisionLoop(charge, {}, events, options);
    const decider = createStickyDecider({
      cache: createRunCache<LiveSession>({ maxRuns: 4, stickyTimeoutMs: 60_000 }),
      decisionOptions: options,
    });
    await decider.decide(runId, charge, {}, events.slice(0, 2));
    const { decision } = await decider.decide(runId, charge, {}, events);
    const outcomeOf = (value: { outcome: string; result?: unknown }): unknown =>
      value.outcome === "completed" ? value.result : value.outcome;
    return [outcomeOf(cold), outcomeOf(decision)];
  }

  it("keeps the first result when a slow attempt 1 fails after attempt 2 succeeded", async () => {
    await startRun();
    const retry = await recorder.recordStepResult({
      runId,
      stepId: "step-1",
      attemptKey: "attempt-2",
      outcome: { status: "completed", result: "r2" },
    });
    const slow = await recorder.recordStepResult({
      runId,
      stepId: "step-1",
      attemptKey: "attempt-1",
      outcome: { status: "failed", error: { name: "Error", message: "timed out" } },
    });

    expect(retry.recorded).toBe(true);
    expect(slow.recorded).toBe(false);
    expect(slow.outcome).toEqual({ status: "completed", result: "r2" });
    const events = await history();
    expect(events.filter((event) => terminalTypes.has(event.type))).toHaveLength(1);
    expect(await replayBothWays(events)).toEqual(["paid:r2", "paid:r2"]);
  });

  it("keeps a first failure when a later success arrives and replays it the same way", async () => {
    await startRun();
    await recorder.recordStepResult({
      runId,
      stepId: "step-1",
      attemptKey: "attempt-1",
      outcome: { status: "failed", error: { name: "Error", message: "declined" } },
    });
    const late = await recorder.recordStepResult({
      runId,
      stepId: "step-1",
      attemptKey: "attempt-2",
      outcome: { status: "completed", result: "r2" },
    });

    expect(late.recorded).toBe(false);
    expect(late.outcome.status).toBe("failed");
    const events = await history();
    expect(events.filter((event) => terminalTypes.has(event.type))).toHaveLength(1);
    expect(await replayBothWays(events)).toEqual(["declined", "declined"]);
  });

  it("writes one terminal event when many attempts finish at once", async () => {
    await startRun();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recorder.recordStepResult({
          runId,
          stepId: "step-1",
          attemptKey: `attempt-${String(index + 1)}`,
          outcome: { status: "completed", result: `r${String(index + 1)}` },
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.recorded)).toHaveLength(1);
    const events = await history();
    expect(events.filter((event) => terminalTypes.has(event.type))).toHaveLength(1);
  });

  it("rejects a second row for the same step at the database", async () => {
    await startRun();
    await database.pool.query(
      "insert into step_results (run_id, step_id, attempt_key, result) values ($1, 'step-1', 'a', '1')",
      [runId],
    );

    await expect(
      database.pool.query(
        "insert into step_results (run_id, step_id, attempt_key, result) values ($1, 'step-1', 'b', '2')",
        [runId],
      ),
    ).rejects.toThrow(/step_results_run_id_step_id_key/);
  });
});
