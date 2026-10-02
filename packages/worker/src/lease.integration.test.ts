import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTaskQueue, type TaskQueue } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import { createDeferred, createVirtualTime, waitFor } from "./test-support.js";
import { createWorker } from "./worker.js";

describe("worker lease against postgres", () => {
  let database: IsolatedSchema;
  let runId: string;
  let namespaceId: string;

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

  async function taskState(taskId: string): Promise<string | undefined> {
    const result = await database.pool.query<{ state: string }>(
      "select state from tasks where id = $1",
      [taskId],
    );
    return result.rows[0]?.state;
  }

  it("does not hand a 60 second heartbeating step to another worker despite a 10 second visibility timeout", async () => {
    const time = createVirtualTime();
    const queue: TaskQueue = createTaskQueue(database.pool, { clock: time.clock });
    const taskId = await queue.enqueue({
      namespaceId,
      runId,
      queueName: "default/long",
      taskType: "STEP_TASK",
    });

    const gate = createDeferred();
    const started: string[] = [];
    let extensions = 0;
    const countingQueue: TaskQueue = {
      ...queue,
      async extend(id, token, timeoutMs) {
        const held = await queue.extend(id, token, timeoutMs);
        extensions += 1;
        return held;
      },
    };
    const common = {
      queueName: "default/long",
      visibilityTimeoutMs: 10_000,
      heartbeatIntervalMs: 3000,
      pollIntervalMs: 1000,
      timers: time.timers,
    };
    const first = createWorker({
      ...common,
      queue: countingQueue,
      handler: async (task) => {
        started.push(`first:${task.id}`);
        await gate.promise;
      },
    });
    const second = createWorker({
      ...common,
      queue,
      handler: (task) => {
        started.push(`second:${task.id}`);
        return Promise.resolve();
      },
    });

    first.start();
    await waitFor(() => first.activeCount === 1);
    second.start();

    for (let second_ = 1; second_ <= 60; second_ += 1) {
      time.advance(1000);
      const expectedBeats = Math.floor(second_ / 3);
      await waitFor(() => extensions >= expectedBeats);
      await waitFor(() => time.pendingDelays().length > 0);
    }

    expect(started).toEqual([`first:${taskId}`]);
    expect(await taskState(taskId)).toBe("LEASED");

    gate.resolve();
    await waitFor(async () => (await taskState(taskId)) === "COMPLETED");
    expect(started).toEqual([`first:${taskId}`]);
    await first.stop();
    await second.stop();
  });

  it("hands the same step to another worker when no heartbeat renews the lease", async () => {
    const time = createVirtualTime();
    const queue = createTaskQueue(database.pool, { clock: time.clock });
    const taskId = await queue.enqueue({
      namespaceId,
      runId,
      queueName: "default/silent",
      taskType: "STEP_TASK",
    });
    const [leased] = await queue.dequeue({
      queueName: "default/silent",
      visibilityTimeoutMs: 10_000,
    });
    expect(leased?.id).toBe(taskId);

    time.advance(11_000);
    const redelivered = await queue.dequeue({
      queueName: "default/silent",
      visibilityTimeoutMs: 10_000,
    });
    expect(redelivered.map((task) => task.id)).toEqual([taskId]);
    expect(redelivered[0]?.attempts).toBe(2);
  });
});
