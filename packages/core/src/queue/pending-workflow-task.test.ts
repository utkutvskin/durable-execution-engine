import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { migrateDown, migrateUp } from "../db/migrator.ts";
import { createResultRecorder } from "../idempotency/recorder.ts";
import { createTaskQueue, type TaskQueue } from "./task-queue.ts";

describe("one pending workflow task per run", () => {
  let database: IsolatedSchema;
  let queue: TaskQueue;
  let namespaceId: string;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    queue = createTaskQueue(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces, run_events cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'fan-out') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
  });

  async function workflowTasks(): Promise<{ id: string; state: string }[]> {
    const result = await database.pool.query<{ id: string; state: string }>(
      `select id, state from tasks where run_id = $1 and task_type = 'WORKFLOW_TASK'
       order by created_at, id`,
      [runId],
    );
    return result.rows;
  }

  function enqueueDecision(delayMs = 0): Promise<string> {
    return queue.enqueue({
      namespaceId,
      runId,
      queueName: "default",
      taskType: "WORKFLOW_TASK",
      delayMs,
    });
  }

  it("merges every workflow task enqueued while one is pending into it, at the earliest time", async () => {
    const first = await enqueueDecision(60_000);
    const merged = await Promise.all(Array.from({ length: 9 }, () => enqueueDecision()));

    expect(new Set(merged)).toEqual(new Set([first]));
    expect(await workflowTasks()).toEqual([{ id: first, state: "PENDING" }]);
    const [leased] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    expect(leased?.id).toBe(first);
  });

  it("gives a fan-out of 20 concurrent step results one decision", async () => {
    const recorder = createResultRecorder(database.pool);
    for (let index = 0; index < 20; index += 1) {
      await queue.enqueue({
        namespaceId,
        runId,
        queueName: "steps",
        taskType: "STEP_TASK",
        payload: { index },
      });
    }
    const tasks = await queue.dequeue({
      queueName: "steps",
      visibilityTimeoutMs: 30_000,
      limit: 20,
    });
    expect(tasks).toHaveLength(20);

    const settled = await Promise.all(
      tasks.map((task, index) =>
        recorder.completeStepTask(task, {
          result: {
            stepId: `step-${String(index)}`,
            attemptKey: "attempt-1",
            outcome: { status: "completed", result: index },
          },
          followUpQueue: "default",
        }),
      ),
    );

    expect(settled.every((entry) => entry.recorded && entry.acked)).toBe(true);
    expect(await workflowTasks()).toHaveLength(1);
    const events = await database.pool.query("select 1 from run_events where run_id = $1", [runId]);
    expect(events.rowCount).toBe(20);
  });

  it("lets a new workflow task wait while the previous one is leased", async () => {
    const first = await enqueueDecision();
    const [leased] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    const second = await enqueueDecision();

    expect(leased?.id).toBe(first);
    expect(second).not.toBe(first);
    expect(await workflowTasks()).toEqual([
      { id: first, state: "LEASED" },
      { id: second, state: "PENDING" },
    ]);
  });

  it("completes a nacked workflow task when another one is already pending", async () => {
    const first = await enqueueDecision();
    const [leased] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    const second = await enqueueDecision(60_000);

    const nacked = await queue.nack(first, leased?.leaseToken ?? "");

    expect(nacked).toBe(true);
    expect(await workflowTasks()).toEqual([
      { id: first, state: "COMPLETED" },
      { id: second, state: "PENDING" },
    ]);
    const [next] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    expect(next?.id).toBe(second);
  });

  it("replaces a pending workflow task that already decided with a fresh one, so the new cause is decided", async () => {
    const recorder = createResultRecorder(database.pool);
    const first = await enqueueDecision();
    const [leased] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: first,
      expectedSeq: 0,
      events: [{ type: "step_scheduled", stepId: "a", stepType: "charge", input: null }],
    });
    expect(await queue.nack(first, leased?.leaseToken ?? "")).toBe(true);

    const second = await enqueueDecision();

    expect(second).not.toBe(first);
    expect(await workflowTasks()).toEqual([
      { id: first, state: "COMPLETED" },
      { id: second, state: "PENDING" },
    ]);
    const decided = await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: second,
      expectedSeq: 1,
      events: [{ type: "run_completed", result: null }],
    });
    expect(decided.recorded).toBe(true);
  });

  it("folds the duplicate pending workflow tasks of an older schema into the earliest one", async () => {
    for (;;) {
      const reverted = await migrateDown(database.pool, undefined, 1);
      if (reverted.includes("0031_one_pending_workflow_task") || reverted.length === 0) {
        break;
      }
    }
    try {
      await database.pool.query(
        `insert into tasks (namespace_id, run_id, queue_name, task_type, visible_at)
         select $1, $2, 'default', 'WORKFLOW_TASK', now() + offsets.minutes * interval '1 minute'
         from unnest(array[3, 1, 2]) as offsets (minutes)`,
        [namespaceId, runId],
      );
    } finally {
      await migrateUp(database.pool);
    }

    const pending = await database.pool.query<{ minutes: number }>(
      `select round(extract(epoch from visible_at - now()) / 60)::int as minutes
       from tasks where run_id = $1 and state = 'PENDING'`,
      [runId],
    );
    expect(pending.rows).toEqual([{ minutes: 1 }]);
    expect(await workflowTasks()).toHaveLength(3);
  });
});
