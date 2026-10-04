import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createTaskQueue, type TaskQueue } from "../queue/task-queue.js";
import { createDeadLetterQueue, type DeadLetterQueue } from "./dead-letters.js";

describe("dead letter queue", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;
  let deadLetters: DeadLetterQueue;
  let queue: TaskQueue;
  let now = new Date("2026-03-01T10:00:00.000Z");
  const clock = { now: () => now };

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
    await database.pool.query("delete from dead_letters");
    await database.pool.query("delete from tasks");
    now = new Date("2026-03-01T10:00:00.000Z");
    deadLetters = createDeadLetterQueue(database.pool, { clock });
    queue = createTaskQueue(database.pool, { clock });
  });

  function entry(stepId = "charge-card") {
    return {
      namespaceId,
      runId,
      stepId,
      queueName: "default/steps",
      payload: { stepId, stepType: "charge", input: { cents: 500 } },
      attempts: 3,
      error: { name: "Error", message: "gateway down" },
      reason: "MAX_ATTEMPTS_EXHAUSTED" as const,
    };
  }

  it("stores a dead letter and reads it back", async () => {
    const id = await deadLetters.add(entry());
    const stored = await deadLetters.get(id);
    expect(stored).toMatchObject({
      id,
      runId,
      stepId: "charge-card",
      attempts: 3,
      reason: "MAX_ATTEMPTS_EXHAUSTED",
      error: { name: "Error", message: "gateway down" },
      requeuedAt: null,
    });
  });

  it("does not store a second waiting entry for the same step", async () => {
    const first = await deadLetters.add(entry());
    const second = await deadLetters.add(entry());
    expect(second).toBe(first);
    expect(await deadLetters.list()).toHaveLength(1);
  });

  it("lists waiting entries and filters by run", async () => {
    await deadLetters.add(entry("a"));
    await deadLetters.add(entry("b"));
    const otherRun = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'other') returning id",
      [namespaceId],
    );
    expect(await deadLetters.list({ runId: otherRun.rows[0]?.id ?? "" })).toEqual([]);
    expect((await deadLetters.list({ runId })).map((letter) => letter.stepId)).toEqual(["a", "b"]);
  });

  it("requeues a dead letter as a step task with a fresh retry budget", async () => {
    const id = await deadLetters.add(entry());
    const taskId = await deadLetters.requeue(id);
    expect(taskId).toBeDefined();

    const [leased] = await queue.dequeue({ queueName: "default/steps", visibilityTimeoutMs: 1000 });
    expect(leased).toMatchObject({
      id: taskId,
      taskType: "STEP_TASK",
      runId,
      payload: {
        stepId: "charge-card",
        stepType: "charge",
        input: { cents: 500 },
        attemptOffset: 3,
      },
    });
  });

  it("marks a requeued entry and hides it from the default listing", async () => {
    const id = await deadLetters.add(entry());
    await deadLetters.requeue(id);
    expect(await deadLetters.list()).toEqual([]);
    const all = await deadLetters.list({ includeRequeued: true });
    expect(all[0]?.requeuedAt).toEqual(now);
  });

  it("requeues an entry only once", async () => {
    const id = await deadLetters.add(entry());
    expect(await deadLetters.requeue(id)).toBeDefined();
    expect(await deadLetters.requeue(id)).toBeUndefined();
    const tasks = await database.pool.query("select 1 from tasks");
    expect(tasks.rowCount).toBe(1);
  });

  it("returns undefined when requeuing an unknown id", async () => {
    expect(await deadLetters.requeue("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("accepts a new dead letter for a step whose earlier entry was requeued", async () => {
    const first = await deadLetters.add(entry());
    await deadLetters.requeue(first);
    const second = await deadLetters.add(entry());
    expect(second).not.toBe(first);
  });

  it("refuses a reason the database does not know", async () => {
    await expect(
      database.pool.query(
        `insert into dead_letters (namespace_id, run_id, step_id, queue_name, attempts, error, reason)
         values ($1, $2, 's', 'q', 1, '{}'::jsonb, 'BORED')`,
        [namespaceId, runId],
      ),
    ).rejects.toThrow();
  });
});
