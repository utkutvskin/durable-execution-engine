import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore } from "../event-store/event-store.ts";
import { createInvariantChecker } from "../invariants/invariant-checker.ts";
import { createTaskQueue, type TaskQueue } from "../queue/task-queue.ts";
import type { ClockSource } from "../workflow/sources.ts";
import { retireFinishedTasks } from "./task-retirement.ts";

const START = new Date("2026-06-01T08:00:00.000Z");
const QUEUE = "retire";

describe("finished task retirement", () => {
  let database: IsolatedSchema;
  let queue: TaskQueue;
  let namespaceId: string;
  let runId: string;
  let now: Date;
  const clock: ClockSource = { now: () => now };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    queue = createTaskQueue(database.pool, { clock });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    now = START;
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'retire') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
  });

  async function completeSteps(count: number, payload: object = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      await queue.enqueue({ namespaceId, runId, queueName: QUEUE, taskType: "STEP_TASK", payload });
      const [leased] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 10_000 });
      if (leased === undefined) {
        throw new Error("no task to lease");
      }
      await queue.ack(leased.id, leased.leaseToken);
      ids.push(leased.id);
      now = new Date(now.getTime() + 1000);
    }
    return ids;
  }

  async function count(table: string, state?: string): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      state === undefined
        ? `select count(*) from ${table}`
        : `select count(*) from ${table} where state = $1`,
      state === undefined ? [] : [state],
    );
    return Number(result.rows[0]?.count);
  }

  it("moves completed tasks that settled before the cutoff and leaves open tasks alone", async () => {
    const finished = await completeSteps(3);
    await queue.enqueue({ namespaceId, runId, queueName: QUEUE, taskType: "STEP_TASK" });
    await queue.enqueue({ namespaceId, runId, queueName: QUEUE, taskType: "STEP_TASK" });
    await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 10_000 });
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, state, quarantined_at)
       values ($1, $2, $3, 'STEP_TASK', 'QUARANTINED', $4)`,
      [namespaceId, runId, QUEUE, START],
    );

    const moved = await retireFinishedTasks(database.pool, {
      before: new Date(START.getTime() + 1500),
      limit: 100,
    });

    expect(moved).toBe(2);
    const history = await database.pool.query<{ id: string }>(
      "select id from task_history order by completed_at",
    );
    expect(history.rows.map((row) => row.id)).toEqual(finished.slice(0, 2));
    const open = await database.pool.query<{ state: string }>(
      "select state from tasks order by state",
    );
    expect(open.rows.map((row) => row.state)).toEqual([
      "COMPLETED",
      "LEASED",
      "PENDING",
      "QUARANTINED",
    ]);
    expect(await count("all_tasks", "COMPLETED")).toBe(3);
  });

  it("moves at most the limit, oldest first, and drains on repeated calls", async () => {
    const finished = await completeSteps(5);
    const before = new Date(now.getTime() + 60_000);

    const batches = [
      await retireFinishedTasks(database.pool, { before, limit: 2 }),
      await retireFinishedTasks(database.pool, { before, limit: 2 }),
      await retireFinishedTasks(database.pool, { before, limit: 2 }),
      await retireFinishedTasks(database.pool, { before, limit: 2 }),
    ];

    expect(batches).toEqual([2, 2, 1, 0]);
    const history = await database.pool.query<{ id: string }>(
      "select id from task_history order by completed_at",
    );
    expect(history.rows.map((row) => row.id)).toEqual(finished);
    expect(await count("tasks")).toBe(0);
  });

  it("never moves a task twice when several retirements race", async () => {
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, state, updated_at)
       select $1, $2, $3, 'STEP_TASK', 'COMPLETED', $4::timestamptz - i * interval '1 millisecond'
       from generate_series(1, 2000) as i`,
      [namespaceId, runId, QUEUE, START],
    );

    const moved = await Promise.all(
      Array.from({ length: 6 }, () =>
        retireFinishedTasks(database.pool, { before: START, limit: 500 }),
      ),
    );

    expect(moved.reduce((total, part) => total + part, 0)).toBe(2000);
    expect(await count("task_history")).toBe(2000);
    expect(await count("tasks")).toBe(0);
  });

  it("refuses to change a row of the append-only task history", async () => {
    await completeSteps(1);
    await retireFinishedTasks(database.pool, { before: now, limit: 10 });

    await expect(database.pool.query("update task_history set attempts = 99")).rejects.toThrow(
      /append-only/,
    );
  });

  it("keeps a completed task that still holds a concurrency slot", async () => {
    const [taskId] = await completeSteps(1);
    await database.pool.query(
      `insert into concurrency_slots
         (namespace_id, scope, concurrency_key, slot, slot_limit, run_id, task_id, lease_token,
          expires_at, acquired_at)
       values ($1, 'step', 'k', 0, 1, $2, $3, gen_random_uuid(), $4, $4)`,
      [namespaceId, runId, taskId, START],
    );

    expect(await retireFinishedTasks(database.pool, { before: now, limit: 10 })).toBe(0);
    await database.pool.query("delete from concurrency_slots");
    expect(await retireFinishedTasks(database.pool, { before: now, limit: 10 })).toBe(1);
  });

  it("lets the invariant checker see retired step tasks", async () => {
    const store = createPostgresEventStore(database.pool);
    await store.append(runId, 0, [{ type: "run_started", workflowType: "retire", input: {} }]);
    const [taskId] = await completeSteps(1, { stepId: "never-recorded" });
    await retireFinishedTasks(database.pool, { before: now, limit: 10 });

    const report = await createInvariantChecker(database.pool, store).check({
      runIds: [runId],
      expectedTaskIds: [taskId ?? ""],
    });

    const lost = report.violations.filter((found) => found.invariant === "task-not-lost");
    expect(lost.map((found) => found.taskId)).toEqual([taskId]);
    expect(lost[0]?.detail).toContain("never-recorded");
  });

  it("rejects a limit that is not a positive integer", async () => {
    await expect(retireFinishedTasks(database.pool, { before: now, limit: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
