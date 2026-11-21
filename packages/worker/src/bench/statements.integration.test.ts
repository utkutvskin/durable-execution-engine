import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresEventStore,
  createResultRecorder,
  createTaskQueue,
  defineStep,
  defineWorkflow,
  type Pool,
} from "@dee/core";
import { createRunService } from "../../../api/src/index.ts";
import { createCountingPool, type CountingPool } from "../../../core/src/db/statement-counter.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { startEngine } from "../engine/runtime.ts";
import { waitFor } from "../test-support.ts";
import { completeBenchRun, startBenchRun, type BenchContext } from "./harness.ts";

const POLL_STATEMENT = /^(with lanes as|select scope, namespace_id, run_id from pauses)/;

describe("statements per run", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let counting: CountingPool;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await pool.query("truncate namespaces cascade");
    const namespace = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    counting = createCountingPool(pool);
  });

  async function runStatus(runId: string): Promise<string | undefined> {
    const result = await pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.status;
  }

  it("runs a three step benchmark run in at most 15 statements", async () => {
    const context: BenchContext = {
      pool: counting.pool,
      store: createPostgresEventStore(counting.pool),
      queue: createTaskQueue(counting.pool),
      namespaceId,
    };
    const runId = await startBenchRun(context, "bench-work", 3);
    const started = counting.statements.length;
    const [task] = await context.queue.dequeue({
      queueName: "bench-work",
      visibilityTimeoutMs: 30_000,
      limit: 8,
    });
    if (task === undefined) {
      throw new Error("the benchmark run's task was not leased");
    }
    await completeBenchRun(context, createResultRecorder(counting.pool), runId, task.payload);
    await context.queue.ack(task.id, task.leaseToken);

    expect(started).toBe(3);
    expect(counting.statements.length).toBeLessThanOrEqual(15);
    expect(await runStatus(runId)).toBe("COMPLETED");
    const history = await createPostgresEventStore(pool).read(runId);
    expect(history.map((stored) => stored.event.type)).toEqual([
      "run_started",
      "step_scheduled",
      "step_scheduled",
      "step_scheduled",
      "step_completed",
      "step_completed",
      "step_completed",
      "run_completed",
    ]);
  });

  it("records each step of a benchmark run in one statement and closes the run in four", async () => {
    const context: BenchContext = {
      pool: counting.pool,
      store: createPostgresEventStore(counting.pool),
      queue: createTaskQueue(counting.pool),
      namespaceId,
    };
    const runId = await startBenchRun(context, "bench-work", 3);
    counting.reset();

    await completeBenchRun(context, createResultRecorder(counting.pool), runId, { steps: 3 });

    const kinds = counting.statements.map((sql) => {
      const called = /from (record_step_result|record_workflow_task|close_run)\(/.exec(sql);
      return called?.[1] ?? sql.split(" ")[0];
    });
    expect(kinds).toEqual([
      "record_step_result",
      "record_step_result",
      "record_step_result",
      "select",
      "begin",
      "record_workflow_task",
      "close_run",
      "commit",
      "select",
    ]);
  });

  it("keeps a three step workflow on the engine, one loop tick and the shutdown at most 90 statements besides the polls", async () => {
    const step = defineStep<number, number>("add-one", {
      handler: (value) => Promise.resolve(value + 1),
    });
    const workflow = defineWorkflow("three-steps", async (ctx, value: number) => {
      let current = value;
      for (let index = 0; index < 3; index += 1) {
        current = await ctx.step("add-one", current);
      }
      return current;
    });
    const engine = startEngine({
      pool: counting.pool,
      workflows: [workflow],
      steps: [step],
      pollIntervalMs: 10,
      loopIntervalMs: 3_600_000,
    });
    try {
      const service = createRunService(counting.pool, { queueName: engine.queueName });
      counting.reset();
      const started = await service.startRun(namespaceId, {
        workflowType: "three-steps",
        input: 1,
      });
      const runId = started.run.runId;
      await waitFor(async () => (await runStatus(runId)) === "COMPLETED");
    } finally {
      await engine.stop();
    }

    const runStatements = counting.statements.filter((sql) => !POLL_STATEMENT.test(sql));
    expect(runStatements.length).toBeLessThanOrEqual(90);
  });
});
