import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { retireFinishedTasks } from "../retention/task-retirement.ts";
import { createTaskQueue } from "./task-queue.ts";

const QUEUE = "churn/workflows";

function recordingPool(pool: Pool, statements: { text: string; values: unknown[] }[]): Pool {
  return new Proxy(pool, {
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
}

describe("dequeue cost after heavy churn", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'churn') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  async function churn(tasks: number): Promise<void> {
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
       select $1, $2, $3, 'STEP_TASK', jsonb_build_object('n', i)
       from generate_series(1, $4::int) as i`,
      [namespaceId, runId, QUEUE, tasks],
    );
    await database.pool.query(
      `update tasks set state = 'LEASED', lease_token = gen_random_uuid(),
                        lease_seq = nextval('task_lease_seq')`,
    );
    await database.pool.query(
      "update tasks set state = 'COMPLETED', lease_token = null, updated_at = now() - interval '1 hour'",
    );
    await retireFinishedTasks(database.pool, { before: new Date(), limit: tasks });
    await database.pool.query("vacuum analyze tasks");
  }

  it("stays under the JIT cost threshold once a busy queue has turned over many tasks", async () => {
    await churn(30_000);
    const queue = createTaskQueue(database.pool);
    const statements: { text: string; values: unknown[] }[] = [];
    const recording = createTaskQueue(recordingPool(database.pool, statements));
    await queue.enqueue({ namespaceId, runId, queueName: QUEUE, taskType: "STEP_TASK" });

    const leased = await recording.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 1_000 });

    expect(leased).toHaveLength(1);
    const dequeue = statements.find((statement) => statement.text.includes("with lanes"));
    const plan = await database.pool.query<{
      "QUERY PLAN": [{ Plan: { "Total Cost": number } }];
    }>(`explain (format json) ${dequeue?.text ?? ""}`, dequeue?.values);
    const threshold = await database.pool.query<{ cost: string }>(
      "select current_setting('jit_above_cost') as cost",
    );
    const cost = plan.rows[0]?.["QUERY PLAN"][0].Plan["Total Cost"] ?? Number.POSITIVE_INFINITY;
    expect(cost).toBeLessThan(Number(threshold.rows[0]?.cost) / 10);
  });
});
