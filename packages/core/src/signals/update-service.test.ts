import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.ts";
import { commandToEvent } from "../workflow/command-events.ts";
import { runDecisionLoop } from "../workflow/decision-loop.ts";
import {
  defineUpdate,
  UnknownUpdateError,
  UpdateRejectedError,
} from "../workflow/define-update.ts";
import { defineWorkflow } from "../workflow/define-workflow.ts";
import type { ClockSource, RandomSource } from "../workflow/sources.ts";
import { createWorkflowRegistry } from "../workflow/workflow-registry.ts";
import { RunNotOpenError, createRunInteractions, type RunInteractions } from "./signal-service.ts";
import { WorkflowNotLoadedError, updateWaitMs } from "./update-service.ts";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const counter = defineWorkflow("counter", async (ctx) => {
  const applied: number[] = [];
  ctx.setQueryHandler("applied", () => [...applied]);
  ctx.setUpdateHandler(
    defineUpdate<number, number>("add", {
      validate: (value) => {
        if (!Number.isInteger(value) || value < 0) {
          throw new Error("value must be a non-negative integer");
        }
        if (applied.includes(value)) {
          throw new Error(`${String(value)} was added already`);
        }
      },
      handler: (value) => {
        applied.push(value);
        return applied.length;
      },
    }),
  );
  await ctx.waitForSignal("stop");
  return applied;
});

describe("workflow updates over postgres", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let runId: string;
  let decisions: number;
  let waitedFor: number[];

  async function history() {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function decideOnce(): Promise<void> {
    decisions += 1;
    const stored = await store.read(runId);
    const decision = await runDecisionLoop(
      counter.handler,
      {},
      stored.map((entry) => entry.event),
      { clock: sources.clock, runId },
    );
    await store.append(
      runId,
      stored.at(-1)?.sequenceNumber ?? 0,
      decision.commands.map(commandToEvent),
    );
  }

  function interactionsWith(
    sleep: (ms: number) => Promise<void>,
    nowMs = () => 0,
  ): RunInteractions {
    const workflows = createWorkflowRegistry();
    workflows.register(counter);
    return createRunInteractions(database.pool, {
      workflows,
      ...sources,
      updateWait: { pollMs: 25, nowMs, sleep },
    });
  }

  async function counts(): Promise<{ events: number; tasks: number }> {
    const events = await database.pool.query("select 1 from run_events where run_id = $1", [runId]);
    const tasks = await database.pool.query("select 1 from tasks where run_id = $1", [runId]);
    return { events: events.rowCount ?? 0, tasks: tasks.rowCount ?? 0 };
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    decisions = 0;
    waitedFor = [];
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from namespaces");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'counter') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "counter", input: {} }]);
  });

  it("accepts a valid update, enqueues a task and returns the handler's result", async () => {
    const interactions = interactionsWith(async (ms) => {
      waitedFor.push(ms);
      await decideOnce();
    });

    const outcome = await interactions.updateRun(runId, "add", 7, { updateId: "u-1" });

    expect(outcome).toEqual({ status: "completed", updateId: "u-1", sequenceNumber: 2, result: 1 });
    expect(decisions).toBe(1);
    expect(waitedFor).toEqual([25]);
    expect(await history()).toEqual([
      { type: "run_started", workflowType: "counter", input: {} },
      { type: "update_accepted", updateId: "u-1", updateName: "add", argument: 7 },
      { type: "update_completed", updateId: "u-1", result: 1 },
    ]);
    const tasks = await database.pool.query<{ payload: unknown }>(
      "select payload from tasks where run_id = $1 and task_type = 'WORKFLOW_TASK'",
      [runId],
    );
    expect(tasks.rows.map((row) => row.payload)).toEqual([{ reason: "update", updateName: "add" }]);
  });

  it("rejects an update its validator refuses and writes nothing", async () => {
    const interactions = interactionsWith(() => Promise.resolve());
    const before = await counts();

    const rejected = interactions.updateRun(runId, "add", -1);

    await expect(rejected).rejects.toBeInstanceOf(UpdateRejectedError);
    await expect(rejected).rejects.toThrow(
      'update "add" was rejected: value must be a non-negative integer',
    );
    expect(await counts()).toEqual(before);
  });

  it("validates against the state the accepted updates before it left", async () => {
    const interactions = interactionsWith(() => decideOnce());
    await interactions.updateRun(runId, "add", 3);
    const before = await counts();

    await expect(interactions.updateRun(runId, "add", 3)).rejects.toThrow("3 was added already");

    expect(await counts()).toEqual(before);
  });

  it("refuses an unknown update name, a closed run and a workflow that is not loaded", async () => {
    const interactions = interactionsWith(() => Promise.resolve());
    await expect(interactions.updateRun(runId, "remove", 1)).rejects.toBeInstanceOf(
      UnknownUpdateError,
    );

    const empty = createRunInteractions(database.pool, {
      workflows: createWorkflowRegistry(),
      ...sources,
    });
    await expect(empty.updateRun(runId, "add", 1)).rejects.toBeInstanceOf(WorkflowNotLoadedError);
    await expect(empty.queryRun(runId, "applied")).rejects.toBeInstanceOf(WorkflowNotLoadedError);

    await database.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [
      runId,
    ]);
    await expect(interactions.updateRun(runId, "add", 1)).rejects.toBeInstanceOf(RunNotOpenError);
    expect(await counts()).toEqual({ events: 1, tasks: 0 });
  });

  it("accepts a repeated update id once and returns the first call's result", async () => {
    const interactions = interactionsWith(() => decideOnce());
    const first = await interactions.updateRun(runId, "add", 5, { updateId: "same" });

    const second = await interactions.updateRun(runId, "add", 5, { updateId: "same" });

    expect(second).toEqual(first);
    const accepted = (await history()).filter((event) => event.type === "update_accepted");
    expect(accepted).toHaveLength(1);
  });

  it("reports accepted when the wait ends before the handler ran", async () => {
    let now = 0;
    const interactions = interactionsWith(
      (ms) => {
        now += ms;
        return Promise.resolve();
      },
      () => now,
    );

    const outcome = await interactions.updateRun(runId, "add", 1, {
      updateId: "slow",
      waitMs: 100,
    });

    expect(outcome).toEqual({ status: "accepted", updateId: "slow", sequenceNumber: 2 });
    expect(now).toBe(100);
    expect((await history()).at(-1)?.type).toBe("update_accepted");
  });

  it("applies concurrent updates one at a time in the order they were accepted", async () => {
    const interactions = interactionsWith(() => Promise.resolve());
    const values = Array.from({ length: 12 }, (_, index) => index);

    const outcomes = await Promise.all(
      values.map((value) => interactions.updateRun(runId, "add", value, { waitMs: 0 })),
    );
    await decideOnce();

    const events = await store.read(runId);
    const acceptedOrder = events.flatMap((entry) =>
      entry.event.type === "update_accepted" ? [entry.event.argument] : [],
    );
    expect([...acceptedOrder].sort((a, b) => Number(a) - Number(b))).toEqual(values);
    expect(outcomes.map((outcome) => outcome.sequenceNumber).sort((a, b) => a - b)).toEqual(
      values.map((value) => value + 2),
    );
    const completed = events.flatMap((entry) =>
      entry.event.type === "update_completed" ? [entry.event.result] : [],
    );
    expect(completed).toEqual(values.map((value) => value + 1));
    expect(await interactions.queryRun(runId, "applied")).toEqual(acceptedOrder);
  });

  it("answers a query from the current state without writing anything", async () => {
    const interactions = interactionsWith(() => decideOnce());
    await interactions.updateRun(runId, "add", 9);
    const before = await counts();

    expect(await interactions.queryRun(runId, "applied")).toEqual([9]);
    expect(await interactions.queryRun(runId, "applied")).toEqual([9]);

    expect(await counts()).toEqual(before);
  });

  it("clamps the requested wait", () => {
    expect(updateWaitMs(undefined)).toBe(10_000);
    expect(updateWaitMs(-5)).toBe(0);
    expect(updateWaitMs(5_000)).toBe(5_000);
    expect(updateWaitMs(10 * 60_000)).toBe(60_000);
  });
});
