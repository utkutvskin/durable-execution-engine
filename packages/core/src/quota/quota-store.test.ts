import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createTaskQueue } from "../queue/task-queue.js";
import { UNLIMITED_QUOTA, createQuotaStore } from "./quota-store.js";

describe("quota store", () => {
  let database: IsolatedSchema;
  let first: string;
  let second: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const result = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('one'), ('two') returning id",
    );
    first = result.rows[0]?.id ?? "";
    second = result.rows[1]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  async function insertRun(namespaceId: string, status = "RUNNING"): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, status)
       values ($1, 'order', $2) returning id`,
      [namespaceId, status],
    );
    return result.rows[0]?.id ?? "";
  }

  it("treats a namespace without a row as unlimited", async () => {
    const store = createQuotaStore(database.pool);
    expect(await store.get(first)).toEqual(UNLIMITED_QUOTA);
  });

  it("stores a quota, replaces it on the second set and keeps namespaces apart", async () => {
    const store = createQuotaStore(database.pool);
    await store.set(first, { maxConcurrentRuns: 5, ratePerSecond: 10, burst: 20 });
    expect(await store.get(first)).toEqual({
      maxConcurrentRuns: 5,
      maxPendingTasks: null,
      ratePerSecond: 10,
      burst: 20,
    });
    await store.set(first, { maxPendingTasks: 7 });
    expect(await store.get(first)).toEqual({
      maxConcurrentRuns: null,
      maxPendingTasks: 7,
      ratePerSecond: null,
      burst: null,
    });
    expect(await store.get(second)).toEqual(UNLIMITED_QUOTA);
  });

  it("refuses a quota the database rejects", async () => {
    const store = createQuotaStore(database.pool);
    await expect(store.set(first, { ratePerSecond: 0 })).rejects.toThrow();
    await expect(store.set(first, { maxConcurrentRuns: -1 })).rejects.toThrow();
  });

  it("measures open runs and open tasks per namespace", async () => {
    const store = createQuotaStore(database.pool);
    const queue = createTaskQueue(database.pool);
    const runA = await insertRun(first);
    await insertRun(first);
    await insertRun(first, "COMPLETED");
    await insertRun(second);
    await queue.enqueue({
      namespaceId: first,
      runId: runA,
      queueName: "q",
      taskType: "STEP_TASK",
    });
    const before = await store.usage(first);
    expect(before.pendingTasks).toBe(1);
    const otherUsage = await store.usage(second);
    expect(otherUsage.pendingTasks).toBe(0);
    const [leased] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 60_000 });
    expect((await store.usage(first)).pendingTasks).toBe(before.pendingTasks);
    await queue.ack(leased?.id ?? "", leased?.leaseToken ?? "");
    expect((await store.usage(first)).pendingTasks).toBe(before.pendingTasks - 1);
    expect(before.openRuns).toBe(2);
    expect((await store.usage(second)).openRuns).toBe(1);
  });

  it("counts the pending tasks of one queue as its depth", async () => {
    const store = createQuotaStore(database.pool);
    const queue = createTaskQueue(database.pool);
    const run = await insertRun(second);
    for (let index = 0; index < 4; index += 1) {
      await queue.enqueue({
        namespaceId: second,
        runId: run,
        queueName: "depth",
        taskType: "STEP_TASK",
      });
    }
    expect(await store.queueDepth("depth")).toBe(4);
    await queue.dequeue({ queueName: "depth", visibilityTimeoutMs: 60_000, limit: 3 });
    expect(await store.queueDepth("depth")).toBe(1);
    expect(await store.queueDepth("empty")).toBe(0);
  });
});
