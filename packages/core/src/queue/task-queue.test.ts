import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import type { ClockSource } from "../workflow/sources.js";
import { createTaskQueue, taskQueueName, type TaskQueue } from "./task-queue.js";

interface FakeClock extends ClockSource {
  advance(ms: number): void;
}

function createFakeClock(start: Date): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("task queue", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;
  let clock: FakeClock;
  let queue: TaskQueue;
  const queueName = taskQueueName("default", "orders");

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from tasks");
    clock = createFakeClock(new Date("2026-01-01T00:00:00Z"));
    queue = createTaskQueue(database.pool, { clock });
  });

  function enqueueOne(
    overrides: { taskType?: "WORKFLOW_TASK" | "STEP_TASK"; delayMs?: number } = {},
  ) {
    return queue.enqueue({
      namespaceId,
      runId,
      queueName,
      taskType: overrides.taskType ?? "STEP_TASK",
      payload: { stepId: "step-0" },
      ...(overrides.delayMs === undefined ? {} : { delayMs: overrides.delayMs }),
    });
  }

  it("builds a namespace-scoped queue name", () => {
    expect(taskQueueName("acme", "orders")).toBe("acme/orders");
    expect(taskQueueName("acme", "orders")).not.toBe(taskQueueName("beta", "orders"));
  });

  it("dequeues an enqueued task with its type and payload", async () => {
    const id = await enqueueOne({ taskType: "WORKFLOW_TASK" });
    const [task] = await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 });
    expect(task).toMatchObject({
      id,
      runId,
      namespaceId,
      queueName,
      taskType: "WORKFLOW_TASK",
      payload: { stepId: "step-0" },
      attempts: 1,
    });
  });

  it("returns nothing from an empty queue and ignores other queues", async () => {
    await enqueueOne();
    expect(await queue.dequeue({ queueName: "other/queue", visibilityTimeoutMs: 1000 })).toEqual(
      [],
    );
  });

  it("hides a leased task from other consumers until the visibility timeout passes", async () => {
    await enqueueOne();
    const first = await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 });
    expect(first).toHaveLength(1);
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 })).toEqual([]);
    clock.advance(29_999);
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 })).toEqual([]);
  });

  it("redelivers a task that was not acked once the visibility timeout expires", async () => {
    const id = await enqueueOne();
    const [first] = await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 });
    clock.advance(30_000);
    const [second] = await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 });
    expect(second?.id).toBe(id);
    expect(second?.attempts).toBe(2);
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
  });

  it("ack completes a task so it is never delivered again", async () => {
    await enqueueOne();
    const [task] = await queue.dequeue({ queueName, visibilityTimeoutMs: 1000 });
    expect(await queue.ack(task?.id ?? "", task?.leaseToken ?? "")).toBe(true);
    clock.advance(10_000);
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 1000 })).toEqual([]);
  });

  it("rejects an ack carrying a stale lease token after redelivery", async () => {
    await enqueueOne();
    const [first] = await queue.dequeue({ queueName, visibilityTimeoutMs: 1000 });
    clock.advance(1000);
    const [second] = await queue.dequeue({ queueName, visibilityTimeoutMs: 1000 });
    expect(await queue.ack(first?.id ?? "", first?.leaseToken ?? "")).toBe(false);
    expect(await queue.ack(second?.id ?? "", second?.leaseToken ?? "")).toBe(true);
  });

  it("nack makes the task visible again immediately, or after a delay", async () => {
    await enqueueOne();
    const [task] = await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 });
    expect(await queue.nack(task?.id ?? "", task?.leaseToken ?? "", 5000)).toBe(true);
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 })).toEqual([]);
    clock.advance(5000);
    const [again] = await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 });
    expect(again?.id).toBe(task?.id);
    expect(await queue.nack(again?.id ?? "", again?.leaseToken ?? "")).toBe(true);
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000 })).toHaveLength(1);
  });

  it("extend pushes the visibility timeout out, and fails once the lease has expired", async () => {
    await enqueueOne();
    const [task] = await queue.dequeue({ queueName, visibilityTimeoutMs: 10_000 });
    clock.advance(9000);
    expect(await queue.extend(task?.id ?? "", task?.leaseToken ?? "", 10_000)).toBe(true);
    clock.advance(9000);
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 10_000 })).toEqual([]);
    clock.advance(1000);
    expect(await queue.extend(task?.id ?? "", task?.leaseToken ?? "", 10_000)).toBe(false);
  });

  it("does not deliver a delayed task before its delay has passed", async () => {
    await enqueueOne({ delayMs: 2000 });
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 1000 })).toEqual([]);
    clock.advance(2000);
    expect(await queue.dequeue({ queueName, visibilityTimeoutMs: 1000 })).toHaveLength(1);
  });

  it("dequeues up to limit tasks, oldest first", async () => {
    const ids = [await enqueueOne(), await enqueueOne(), await enqueueOne()];
    const tasks = await queue.dequeue({ queueName, visibilityTimeoutMs: 1000, limit: 2 });
    expect(tasks.map((task) => task.id)).toEqual(ids.slice(0, 2));
  });

  it("rejects a non-positive visibility timeout and a task type the database does not know", async () => {
    await expect(queue.dequeue({ queueName, visibilityTimeoutMs: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      database.pool.query(
        "insert into tasks (namespace_id, run_id, queue_name, task_type) values ($1, $2, 'q', 'BOGUS')",
        [namespaceId, runId],
      ),
    ).rejects.toThrow();
  });

  it("hands 1000 tasks to 8 parallel consumers with none duplicated and none lost", async () => {
    const enqueued = new Set<string>();
    for (let batch = 0; batch < 20; batch += 1) {
      const ids = await Promise.all(Array.from({ length: 50 }, () => enqueueOne()));
      ids.forEach((id) => enqueued.add(id));
    }

    async function consume(): Promise<string[]> {
      const seen: string[] = [];
      for (;;) {
        const tasks = await queue.dequeue({ queueName, visibilityTimeoutMs: 60_000, limit: 5 });
        if (tasks.length === 0) {
          return seen;
        }
        for (const task of tasks) {
          seen.push(task.id);
          await queue.ack(task.id, task.leaseToken);
        }
      }
    }

    const perConsumer = await Promise.all(Array.from({ length: 8 }, () => consume()));
    const all = perConsumer.flat();
    expect(all).toHaveLength(1000);
    expect(new Set(all)).toEqual(enqueued);
    expect(perConsumer.filter((seen) => seen.length > 0).length).toBeGreaterThan(1);
  });
});
