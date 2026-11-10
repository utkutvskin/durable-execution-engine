import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRunControl } from "../cancellation/run-control.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.ts";
import { createJanitor } from "../recovery/janitor.ts";
import { createScheduleManager } from "../schedules/schedule-manager.ts";
import { createRunInteractions } from "../signals/signal-service.ts";
import { createTimerScheduler } from "../timers/timer-scheduler.ts";
import { createWorkflowRegistry } from "../workflow/workflow-registry.ts";

const START = new Date(Math.floor((Date.now() - 3_600_000) / 60_000) * 60_000);
const LATER = new Date(Date.now() + 3_600_000);
const clock = { now: () => LATER };
const sources = { clock, random: { random: () => 0.5, uuid: () => "fixed-uuid" } };

describe("routing by the run's queue", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  async function createRun(queueName: string, parentRunId?: string): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      `insert into workflow_runs
         (namespace_id, workflow_type, queue_name, created_at, parent_run_id, parent_child_id)
       values ($1, 'sample', $2, $3, $4, $5) returning id`,
      [namespaceId, queueName, START, parentRunId ?? null, parentRunId === undefined ? null : "c1"],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "sample", input: {} }]);
    return runId;
  }

  async function queuesOf(runId: string): Promise<string[]> {
    const tasks = await database.pool.query<{ queue_name: string }>(
      "select queue_name from tasks where run_id = $1 order by created_at, id",
      [runId],
    );
    return tasks.rows.map((row) => row.queue_name);
  }

  it("fires a timer only on the engine of the run's queue and enqueues to that queue", async () => {
    const runId = await createRun("pool-b");
    const fireAt = new Date(START.getTime() + 60_000);
    const forA = createTimerScheduler(database.pool, { queueName: "pool-a", clock });
    const forB = createTimerScheduler(database.pool, { queueName: "pool-b", clock });
    await forA.schedule({ runId, timerId: "t1", fireAt });

    expect((await forA.tick()).fired).toEqual([]);
    expect(await queuesOf(runId)).toEqual([]);
    expect((await forB.tick()).fired).toHaveLength(1);
    expect(await queuesOf(runId)).toEqual(["pool-b"]);
  });

  it("delivers a signal to the queue of the run, not to a queue of the sender", async () => {
    const runId = await createRun("pool-b");
    const workflows = createWorkflowRegistry();
    const interactions = createRunInteractions(database.pool, { workflows, ...sources });

    await interactions.signalRun(runId, "approve", { by: "ops" });

    expect(await queuesOf(runId)).toEqual(["pool-b"]);
  });

  it("enqueues a cancellation to the queue of the run", async () => {
    const runId = await createRun("pool-b");

    await createRunControl(database.pool).cancelRun(runId, "no longer needed");

    expect(await queuesOf(runId)).toEqual(["pool-b"]);
  });

  it("wakes a parent on the parent's queue even when the child's tasks are gone", async () => {
    const parentId = await createRun("pool-a");
    const childId = await createRun("pool-b", parentId);
    await store.append(parentId, 1, [
      {
        type: "child_started",
        childId: "c1",
        workflowType: "sample",
        input: {},
        parentClosePolicy: "cancel",
      },
    ]);
    await database.pool.query("delete from tasks");

    await createRunControl(database.pool).terminateRun(childId, "done with it");

    expect(await queuesOf(parentId)).toEqual(["pool-a"]);
  });

  it("recovers stalled runs only for the engine's queue, onto the run's queue", async () => {
    const runA = await createRun("pool-a");
    const runB = await createRun("pool-b");
    const janitor = createJanitor(database.pool, { clock });

    const recovered = await janitor.recoverStalledRuns({ queueName: "pool-b", graceMs: 1000 });

    expect(recovered.map((run) => run.runId)).toEqual([runB]);
    expect(await queuesOf(runB)).toEqual(["pool-b"]);
    expect(await queuesOf(runA)).toEqual([]);
    expect(await janitor.findStalledRuns({ queueName: "pool-a", graceMs: 1000 })).toHaveLength(1);
  });

  it("starts a schedule only on the engine of its queue and puts the run on that queue", async () => {
    const managerA = createScheduleManager(database.pool, { queueName: "pool-a", clock });
    const managerB = createScheduleManager(database.pool, { queueName: "pool-b", clock });
    const schedule = await managerB.create({
      namespaceId,
      name: "every-minute",
      cronExpression: "* * * * *",
      workflowType: "sample",
      startAt: START,
    });

    expect((await managerA.tick()).triggers).toEqual([]);
    const started = (await managerB.tick()).triggers;

    expect(started).toHaveLength(1);
    const runId = started[0]?.runId ?? "";
    expect(await queuesOf(runId)).toEqual([schedule.queueName]);
    const run = await database.pool.query<{ queue_name: string }>(
      "select queue_name from workflow_runs where id = $1",
      [runId],
    );
    expect(run.rows[0]?.queue_name).toBe("pool-b");
  });

  it("leaves two engines on one database with disjoint timers, signals and recoveries", async () => {
    const runA = await createRun("pool-a");
    const runB = await createRun("pool-b");
    const timersA = createTimerScheduler(database.pool, { queueName: "pool-a", clock });
    const timersB = createTimerScheduler(database.pool, { queueName: "pool-b", clock });
    const fireAt = new Date(START.getTime() + 60_000);
    await timersA.schedule({ runId: runA, timerId: "t1", fireAt });
    await timersB.schedule({ runId: runB, timerId: "t1", fireAt });
    const interactions = createRunInteractions(database.pool, {
      workflows: createWorkflowRegistry(),
      ...sources,
    });

    await Promise.all([timersA.tick(), timersB.tick()]);
    await interactions.signalRun(runA, "go");
    await interactions.signalRun(runB, "go");
    await database.pool.query("update tasks set state = 'COMPLETED'");
    const janitor = createJanitor(database.pool, { clock });
    await janitor.sweep({ queueName: "pool-a", graceMs: 1000 });

    const all = await database.pool.query<{ run_id: string; queue_name: string }>(
      "select run_id, queue_name from tasks",
    );
    const misrouted = all.rows.filter(
      (row) => row.queue_name !== (row.run_id === runA ? "pool-a" : "pool-b"),
    );
    expect(all.rows.length).toBeGreaterThanOrEqual(4);
    expect(misrouted).toEqual([]);
  });
});
