import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RunAlreadyClosedError } from "../cancellation/run-control.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore } from "../event-store/event-store.ts";
import { createTaskQueue, type TaskQueue } from "../queue/task-queue.ts";
import { RunNotFoundError } from "../signals/signal-service.ts";
import { createTimerScheduler } from "../timers/timer-scheduler.ts";
import { createPauseControl, type PauseControl } from "./pauses.ts";

const QUEUE = "default/workflows";
const OTHER_QUEUE = "default/reports";
const START = new Date("2026-03-01T10:00:00.000Z");

describe("pause and resume", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let otherNamespaceId: string;
  let now = START;
  const clock = { now: () => now };
  let queue: TaskQueue;
  let pauses: PauseControl;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    queue = createTaskQueue(database.pool, { clock });
    pauses = createPauseControl(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    now = START;
    namespaceId = await createNamespace("default");
    otherNamespaceId = await createNamespace("other");
  });

  async function createNamespace(name: string): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ($1) returning id",
      [name],
    );
    return result.rows[0]?.id ?? "";
  }

  async function createRun(namespace = namespaceId, queueName = QUEUE): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, queue_name)
       values ($1, 'held', $2) returning id`,
      [namespace, queueName],
    );
    return result.rows[0]?.id ?? "";
  }

  async function enqueueTasks(runId: string, count: number, namespace = namespaceId) {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(
        await queue.enqueue({
          namespaceId: namespace,
          runId,
          queueName: QUEUE,
          taskType: index === 0 ? "WORKFLOW_TASK" : "STEP_TASK",
          payload: { index },
        }),
      );
      now = new Date(now.getTime() + 1);
    }
    return ids;
  }

  async function drain(queueName = QUEUE): Promise<string[]> {
    const leased: string[] = [];
    for (;;) {
      const batch = await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000, limit: 10 });
      if (batch.length === 0) {
        return leased;
      }
      for (const task of batch) {
        leased.push(task.id);
        await queue.ack(task.id, task.leaseToken);
      }
    }
  }

  async function taskStates(): Promise<Record<string, string>> {
    const rows = await database.pool.query<{ id: string; state: string }>(
      "select id, state from tasks",
    );
    return Object.fromEntries(rows.rows.map((row) => [row.id, row.state]));
  }

  it("a paused queue dequeues nothing and resumes with every task intact, in order", async () => {
    const runs = [await createRun(), await createRun(), await createRun()];
    const enqueued: string[] = [];
    for (const runId of runs) {
      enqueued.push(...(await enqueueTasks(runId, 4)));
    }
    await pauses.pause({ scope: "queue", namespaceId, queueName: QUEUE }, "maintenance");

    now = new Date(now.getTime() + 60 * 60_000);
    for (let poll = 0; poll < 5; poll += 1) {
      expect(
        await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 30_000, limit: 50 }),
      ).toEqual([]);
    }
    expect(Object.values(await taskStates())).toEqual(enqueued.map(() => "PENDING"));
    const payloads = await database.pool.query<{ payload: unknown }>(
      "select payload from tasks order by created_at",
    );
    expect(payloads.rows).toHaveLength(12);

    expect(await pauses.resume({ scope: "queue", namespaceId, queueName: QUEUE })).toBe(true);
    const leased: string[] = [];
    for (;;) {
      const [task] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 30_000 });
      if (task === undefined) {
        break;
      }
      leased.push(task.id);
      await queue.ack(task.id, task.leaseToken);
    }
    expect(leased).toEqual(enqueued);
    expect(Object.values(await taskStates())).toEqual(enqueued.map(() => "COMPLETED"));
  });

  it("a queue pause holds back only that queue of that namespace", async () => {
    const held = await createRun();
    await enqueueTasks(held, 2);
    const otherTenant = await createRun(otherNamespaceId);
    const otherTenantTasks = await enqueueTasks(otherTenant, 2, otherNamespaceId);
    const otherQueueRun = await createRun(namespaceId, OTHER_QUEUE);
    const otherQueueTask = await queue.enqueue({
      namespaceId,
      runId: otherQueueRun,
      queueName: OTHER_QUEUE,
      taskType: "WORKFLOW_TASK",
    });
    await pauses.pause({ scope: "queue", namespaceId, queueName: QUEUE });

    expect((await drain()).sort()).toEqual([...otherTenantTasks].sort());
    expect(await drain(OTHER_QUEUE)).toEqual([otherQueueTask]);
  });

  it("a paused namespace dequeues nothing on any queue and other namespaces keep flowing", async () => {
    const held = await createRun();
    const heldTasks = await enqueueTasks(held, 3);
    const heldOnOtherQueue = await createRun(namespaceId, OTHER_QUEUE);
    await queue.enqueue({
      namespaceId,
      runId: heldOnOtherQueue,
      queueName: OTHER_QUEUE,
      taskType: "WORKFLOW_TASK",
    });
    const flowing = await createRun(otherNamespaceId);
    const flowingTasks = await enqueueTasks(flowing, 3, otherNamespaceId);
    await pauses.pause({ scope: "namespace", namespaceId });

    expect((await drain()).sort()).toEqual([...flowingTasks].sort());
    expect(await drain(OTHER_QUEUE)).toEqual([]);

    await pauses.resume({ scope: "namespace", namespaceId });
    expect((await drain()).sort()).toEqual([...heldTasks].sort());
    expect(await drain(OTHER_QUEUE)).toHaveLength(1);
  });

  it("a paused run's tasks are passed over while the rest of its queue is leased", async () => {
    const held = await createRun();
    const heldTasks = await enqueueTasks(held, 3);
    const neighbour = await createRun();
    const neighbourTasks = await enqueueTasks(neighbour, 3);
    await pauses.pause({ scope: "run", namespaceId, runId: held });

    expect(await drain()).toEqual(neighbourTasks);
    await pauses.resume({ scope: "run", namespaceId, runId: held });
    expect(await drain()).toEqual(heldTasks);
  });

  it("a timer of a paused run still fires, and its workflow task waits for the resume", async () => {
    const runId = await createRun();
    await pauses.pause({ scope: "run", namespaceId, runId });
    const timers = createTimerScheduler(database.pool, { queueName: QUEUE, clock });
    await timers.schedule({ runId, timerId: "nap", fireAt: new Date(START.getTime() + 5_000) });

    now = new Date(START.getTime() + 5_000);
    expect((await timers.tick()).fired).toHaveLength(1);
    const events = await createPostgresEventStore(database.pool).read(runId);
    expect(events.map((stored) => stored.event)).toEqual([{ type: "timer_fired", timerId: "nap" }]);
    expect(await drain()).toEqual([]);
    expect(Object.values(await taskStates())).toEqual(["PENDING"]);

    await pauses.resume({ scope: "run", namespaceId, runId });
    expect(await drain()).toHaveLength(1);
  });

  it("an expired lease of a paused run is reclaimed only after the resume", async () => {
    const runId = await createRun();
    const [taskId] = await enqueueTasks(runId, 1);
    const [leased] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 1_000 });
    expect(leased?.id).toBe(taskId);
    await pauses.pause({ scope: "run", namespaceId, runId });

    now = new Date(now.getTime() + 10_000);
    expect(await drain()).toEqual([]);
    await pauses.resume({ scope: "run", namespaceId, runId });
    const [reclaimed] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 1_000 });
    expect(reclaimed).toMatchObject({ id: taskId, attempts: 2 });
  });

  it("pausing twice keeps the first pause, and resuming what is not paused reports false", async () => {
    const first = await pauses.pause({ scope: "namespace", namespaceId }, "first");
    const second = await pauses.pause({ scope: "namespace", namespaceId }, "second");
    expect(first.created).toBe(true);
    expect(second).toEqual({ pause: first.pause, created: false });
    expect(await pauses.list(namespaceId)).toEqual([first.pause]);
    expect(await pauses.resume({ scope: "namespace", namespaceId })).toBe(true);
    expect(await pauses.resume({ scope: "namespace", namespaceId })).toBe(false);
    expect(await pauses.list(namespaceId)).toEqual([]);
  });

  it("refuses to pause a run of another namespace, an unknown run and a closed run", async () => {
    const foreign = await createRun(otherNamespaceId);
    await expect(pauses.pause({ scope: "run", namespaceId, runId: foreign })).rejects.toThrow(
      RunNotFoundError,
    );
    await expect(pauses.pause({ scope: "run", namespaceId, runId: "not-a-uuid" })).rejects.toThrow(
      RunNotFoundError,
    );
    const closed = await createRun();
    await database.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [
      closed,
    ]);
    await expect(pauses.pause({ scope: "run", namespaceId, runId: closed })).rejects.toThrow(
      RunAlreadyClosedError,
    );
    expect(await pauses.resume({ scope: "run", namespaceId, runId: "not-a-uuid" })).toBe(false);
  });

  it("keeps the dequeue statement under the JIT cost threshold with and without pauses", async () => {
    const statements: { text: string; values: unknown[] }[] = [];
    const recording = new Proxy(database.pool, {
      get(target, property, receiver) {
        if (property !== "query") {
          return Reflect.get(target, property, receiver) as unknown;
        }
        return (text: string, values: unknown[]) => {
          statements.push({ text, values });
          return target.query(text, values);
        };
      },
    });
    const recordingQueue = createTaskQueue(recording, { clock });
    const runId = await createRun();
    await enqueueTasks(runId, 1);
    const threshold = await database.pool.query<{ cost: string }>(
      "select current_setting('jit_above_cost') as cost",
    );

    async function dequeueCost(): Promise<number> {
      statements.length = 0;
      await recordingQueue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 1_000 });
      const dequeue = statements.find((statement) => statement.text.includes("with lanes"));
      const plan = await database.pool.query<{
        "QUERY PLAN": [{ Plan: { "Total Cost": number } }];
      }>(`explain (format json) ${dequeue?.text ?? ""}`, dequeue?.values);
      return plan.rows[0]?.["QUERY PLAN"][0].Plan["Total Cost"] ?? Number.POSITIVE_INFINITY;
    }

    const unpaused = await dequeueCost();
    await pauses.pause({ scope: "namespace", namespaceId: otherNamespaceId });
    await pauses.pause({ scope: "run", namespaceId, runId });
    const paused = await dequeueCost();
    expect(unpaused).toBeLessThan(Number(threshold.rows[0]?.cost));
    expect(paused).toBeLessThan(Number(threshold.rows[0]?.cost));
  });

  it("lists the pauses that hold back a run, its own first", async () => {
    const runId = await createRun();
    expect(await pauses.pausesOfRun(namespaceId, runId)).toEqual([]);
    await pauses.pause({ scope: "namespace", namespaceId });
    await pauses.pause({ scope: "queue", namespaceId, queueName: OTHER_QUEUE });
    await pauses.pause({ scope: "queue", namespaceId, queueName: QUEUE });
    await pauses.pause({ scope: "run", namespaceId, runId });
    const held = await pauses.pausesOfRun(namespaceId, runId);
    expect(held.map((pause) => pause.scope)).toEqual(["run", "queue", "namespace"]);
    expect(held[1]?.queueName).toBe(QUEUE);
    expect(await pauses.pausesOfRun(otherNamespaceId, runId)).toEqual([]);
  });
});
