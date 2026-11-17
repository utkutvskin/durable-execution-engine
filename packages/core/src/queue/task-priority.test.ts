import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { startWorkflow } from "../embedded/transactional.ts";
import { InvalidPriorityError, validatePriority } from "../run/priority.ts";
import type { ClockSource } from "../workflow/sources.ts";
import { createTaskQueue, type TaskQueue, type TaskType } from "./task-queue.ts";

const QUEUE = "default";

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

describe("task priorities and namespace fairness", () => {
  let database: IsolatedSchema;
  let clock: FakeClock;
  let queue: TaskQueue;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    clock = createFakeClock(new Date("2026-01-01T00:00:00Z"));
    queue = createTaskQueue(database.pool, { clock });
  });

  async function createNamespace(name: string): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ($1) returning id",
      [name],
    );
    return result.rows[0]?.id ?? "";
  }

  async function createRun(namespaceId: string, priority = 0): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, queue_name, priority)
       values ($1, 'filler', $2, $3) returning id`,
      [namespaceId, QUEUE, priority],
    );
    return result.rows[0]?.id ?? "";
  }

  async function seedBacklog(
    namespaceId: string,
    count: number,
    options: { readonly ageSeconds: number; readonly taskType?: TaskType },
  ): Promise<void> {
    await database.pool.query(
      `with runs as (
         insert into workflow_runs (namespace_id, workflow_type, queue_name)
         select $1, 'filler', $2 from generate_series(1, $3::int)
         returning id
       )
       insert into tasks (namespace_id, run_id, queue_name, task_type, visible_at)
       select $1, runs.id, $2, $4, $5::timestamptz - $6 * interval '1 second' from runs`,
      [
        namespaceId,
        QUEUE,
        count,
        options.taskType ?? "WORKFLOW_TASK",
        clock.now(),
        options.ageSeconds,
      ],
    );
  }

  async function takeOne(): Promise<{ namespaceId: string; priority: number; runId: string }> {
    const [task] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 30_000 });
    if (task === undefined) {
      throw new Error("the queue returned no task");
    }
    await queue.ack(task.id, task.leaseToken);
    return { namespaceId: task.namespaceId, priority: task.priority, runId: task.runId };
  }

  it("gives every task the priority of its run, whoever inserts it", async () => {
    const namespaceId = await createNamespace("default");
    const runId = await createRun(namespaceId, 7);
    await queue.enqueue({ namespaceId, runId, queueName: QUEUE, taskType: "STEP_TASK" });
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, priority)
       values ($1, $2, $3, 'WORKFLOW_TASK', -5)`,
      [namespaceId, runId, QUEUE],
    );
    const stored = await database.pool.query<{ priority: number }>(
      "select priority from tasks where run_id = $1",
      [runId],
    );
    expect(stored.rows.map((row) => row.priority)).toEqual([7, 7]);
    expect((await takeOne()).priority).toBe(7);
  });

  it("hands out a high-priority task before 10,000 older low-priority ones, through an index", async () => {
    const namespaceId = await createNamespace("default");
    await seedBacklog(namespaceId, 10_000, { ageSeconds: 60 });
    const urgentRun = await createRun(namespaceId, 10);
    await queue.enqueue({
      namespaceId,
      runId: urgentRun,
      queueName: QUEUE,
      taskType: "WORKFLOW_TASK",
    });
    await database.pool.query("analyze tasks");

    const first = await takeOne();

    expect(first).toEqual({ namespaceId, priority: 10, runId: urgentRun });
    const plan = await database.pool.query<{ "QUERY PLAN": string }>(
      `explain select id from tasks
       where queue_name = $1 and namespace_id = $2 and task_type = 'WORKFLOW_TASK'
         and state in ('PENDING', 'LEASED') and visible_at <= now()
       order by priority desc, visible_at, created_at, id
       limit 4`,
      [QUEUE, namespaceId],
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("tasks_fair_dequeue_idx");
    expect(text).not.toContain("Seq Scan");
    expect(text).not.toContain("Sort");
  });

  it("serves a namespace holding 10 tasks before one holding 10,000 older ones", async () => {
    const big = await createNamespace("big");
    const small = await createNamespace("small");
    await seedBacklog(big, 10_000, { ageSeconds: 600 });
    await seedBacklog(small, 10, { ageSeconds: 1 });

    const served: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      served.push((await takeOne()).namespaceId);
    }

    expect(served.filter((id) => id === small)).toHaveLength(10);
    expect(served.filter((id) => id === big)).toHaveLength(10);
    const remaining = await database.pool.query<{ namespace_id: string; open: string }>(
      `select namespace_id, count(*) as open from tasks where state = 'PENDING'
       group by namespace_id`,
    );
    expect(remaining.rows).toEqual([{ namespace_id: big, open: "9990" }]);
  });

  it("interleaves namespaces within one dequeue and keeps priority above fairness", async () => {
    const first = await createNamespace("first");
    const second = await createNamespace("second");
    await seedBacklog(first, 6, { ageSeconds: 60 });
    await seedBacklog(second, 6, { ageSeconds: 30 });
    const urgent = await createRun(second, 3);
    await queue.enqueue({
      namespaceId: second,
      runId: urgent,
      queueName: QUEUE,
      taskType: "WORKFLOW_TASK",
    });

    const tasks = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 30_000, limit: 5 });

    expect(tasks.map((task) => task.runId)[0]).toBe(urgent);
    const rest = tasks.slice(1).map((task) => task.namespaceId);
    expect(rest.filter((id) => id === first)).toHaveLength(2);
    expect(rest.filter((id) => id === second)).toHaveLength(2);
  });

  it("takes only the task types a dequeue asks for", async () => {
    const namespaceId = await createNamespace("default");
    await seedBacklog(namespaceId, 3, { ageSeconds: 60, taskType: "STEP_TASK" });
    await seedBacklog(namespaceId, 2, { ageSeconds: 1, taskType: "WORKFLOW_TASK" });

    const decisions = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 30_000,
      limit: 10,
      taskTypes: ["WORKFLOW_TASK"],
    });
    const steps = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 30_000,
      limit: 10,
      taskTypes: ["STEP_TASK"],
    });

    expect(decisions.map((task) => task.taskType)).toEqual(["WORKFLOW_TASK", "WORKFLOW_TASK"]);
    expect(steps.map((task) => task.taskType)).toEqual(["STEP_TASK", "STEP_TASK", "STEP_TASK"]);
    await expect(
      queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 30_000, taskTypes: [] }),
    ).rejects.toThrow(RangeError);
  });

  it("starts an embedded run with a priority and refuses one out of range", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const started = await startWorkflow(client, { workflowType: "urgent", priority: 50 });
      await expect(
        startWorkflow(client, { workflowType: "urgent", priority: 1001 }),
      ).rejects.toBeInstanceOf(InvalidPriorityError);
      await client.query("commit");
      const stored = await database.pool.query<{ run: number; task: number }>(
        `select r.priority as run, t.priority as task
         from workflow_runs r join tasks t on t.run_id = r.id where r.id = $1`,
        [started.runId],
      );
      expect(stored.rows).toEqual([{ run: 50, task: 50 }]);
    } finally {
      client.release();
    }
  });

  it("validates priorities", () => {
    expect(validatePriority(undefined)).toBe(0);
    expect(validatePriority(-1000)).toBe(-1000);
    expect(validatePriority(1000)).toBe(1000);
    expect(() => validatePriority(1.5)).toThrow(InvalidPriorityError);
    expect(() => validatePriority(-1001)).toThrow(/from -1000 to 1000, got -1001/);
    expect(() => validatePriority(Number.NaN)).toThrow(InvalidPriorityError);
  });
});
