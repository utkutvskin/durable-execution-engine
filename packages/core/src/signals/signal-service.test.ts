import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import { runDecisionLoop } from "../workflow/decision-loop.js";
import { defineWorkflow } from "../workflow/define-workflow.js";
import { UnknownQueryError } from "../workflow/query.js";
import type { ClockSource, RandomSource } from "../workflow/sources.js";
import { createWorkflowRegistry } from "../workflow/workflow-registry.js";
import {
  RunNotFoundError,
  RunNotOpenError,
  createRunInteractions,
  type RunInteractions,
} from "./signal-service.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const approval = defineWorkflow("approval", async (ctx) => {
  let state = "waiting";
  ctx.setQueryHandler("state", () => state);
  const decision = await ctx.waitForSignal<string>("decision");
  state = `decided:${decision}`;
  return decision;
});

describe("run interactions", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let interactions: RunInteractions;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    const workflows = createWorkflowRegistry();
    workflows.register(approval);
    interactions = createRunInteractions(database.pool, {
      queueName: "default",
      workflows,
      ...sources,
    });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from namespaces");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'approval') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "approval", input: {} }]);
  });

  async function history() {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  it("records a signal as an event and enqueues one workflow task", async () => {
    const receipt = await interactions.signalRun(runId, "decision", "yes");

    expect(receipt.sequenceNumber).toBe(2);
    expect((await history())[1]).toEqual({
      type: "signal_received",
      signalName: "decision",
      payload: "yes",
    });
    const tasks = await database.pool.query<{ task_type: string; payload: { reason: string } }>(
      "select task_type, payload from tasks where run_id = $1",
      [runId],
    );
    expect(tasks.rows).toEqual([
      { task_type: "WORKFLOW_TASK", payload: { reason: "signal", signalName: "decision" } },
    ]);
  });

  it("delivers a signal sent before the run enters the wait", async () => {
    await interactions.signalRun(runId, "decision", "early");

    const result = await runDecisionLoop(approval.handler, {}, await history(), sources);

    expect(result).toMatchObject({ outcome: "completed", result: "early" });
  });

  it("appends concurrent signals without losing any", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => interactions.signalRun(runId, "tick", index)),
    );

    const signals = (await history()).filter((event) => event.type === "signal_received");
    expect(signals).toHaveLength(10);
    const sequences = (await store.read(runId)).map((stored) => stored.sequenceNumber);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("rejects a signal for a run that does not exist", async () => {
    await expect(
      interactions.signalRun("00000000-0000-0000-0000-000000000000", "decision"),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("rejects a signal for a run that is closed and records nothing", async () => {
    await database.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [
      runId,
    ]);

    await expect(interactions.signalRun(runId, "decision")).rejects.toBeInstanceOf(RunNotOpenError);
    expect(await history()).toHaveLength(1);
    const tasks = await database.pool.query("select 1 from tasks");
    expect(tasks.rowCount).toBe(0);
  });

  it("answers a query with the state at the run's current point", async () => {
    expect(await interactions.queryRun(runId, "state")).toBe("waiting");
  });

  it("writes nothing to the event log, the tasks or the run row when queried", async () => {
    const before = await database.pool.query(
      "select (select count(*) from run_events) as events, (select count(*) from tasks) as tasks, (select updated_at from workflow_runs where id = $1) as updated",
      [runId],
    );

    await interactions.queryRun(runId, "state");
    await interactions.queryRun(runId, "state");

    const after = await database.pool.query(
      "select (select count(*) from run_events) as events, (select count(*) from tasks) as tasks, (select updated_at from workflow_runs where id = $1) as updated",
      [runId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("rejects an unknown query and a query for a missing run", async () => {
    await expect(interactions.queryRun(runId, "nope")).rejects.toBeInstanceOf(UnknownQueryError);
    await expect(
      interactions.queryRun("00000000-0000-0000-0000-000000000000", "state"),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
