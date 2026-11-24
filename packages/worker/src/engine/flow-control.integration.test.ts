import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineStep, defineWorkflow, type Pool } from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { startEngine, type Engine, type EngineOptions } from "./runtime.ts";

const POLL_INTERVAL_MS = 200;

const filler = defineWorkflow("filler", () => Promise.resolve("filled"));

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("flow control in the engine", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let service: RunService;
  let engine: Engine | undefined;
  const errors: unknown[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
    service = createRunService(pool, { queueName: "default" });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await pool.query("truncate namespaces cascade");
    errors.length = 0;
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  function boot(options: Omit<EngineOptions, "pool" | "onError">): Engine {
    engine = startEngine({
      pool,
      pollIntervalMs: POLL_INTERVAL_MS,
      loopIntervalMs: 1000,
      stickyRouting: false,
      shutdownTimeoutMs: 2_000,
      ...options,
      onError: (error) => {
        errors.push(error);
      },
    });
    return engine;
  }

  async function createNamespace(name: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ($1) returning id",
      [name],
    );
    return result.rows[0]?.id ?? "";
  }

  async function seedFillers(namespaceId: string, count: number, ageSeconds: number) {
    await pool.query(
      `with runs as (
         insert into workflow_runs (namespace_id, workflow_type, input, queue_name, created_at)
         select $1, 'filler', 'null'::jsonb, 'default', now() - $3 * interval '1 second'
         from generate_series(1, $2::int)
         returning id, created_at
       ),
       events as (
         insert into run_events
           (run_id, sequence_number, event_type, payload, event_version, run_created_at)
         select id, 1, 'run_started',
                '{"type":"run_started","workflowType":"filler","input":null}'::jsonb, 1, created_at
         from runs
       )
       insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
       select $1, id, 'default', 'WORKFLOW_TASK', '{"reason":"start"}'::jsonb,
              now() - $3 * interval '1 second'
       from runs`,
      [namespaceId, count, ageSeconds],
    );
    await pool.query("analyze tasks");
  }

  async function completedCount(namespaceId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "select count(*) from workflow_runs where namespace_id = $1 and status = 'COMPLETED'",
      [namespaceId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async function status(runId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.status ?? "missing";
  }

  it("completes a high-priority run within one poll interval of a free slot, with 10,000 low-priority tasks queued", async () => {
    const namespaceId = await createNamespace("default");
    await seedFillers(namespaceId, 10_000, 60);
    const urgent = defineWorkflow("urgent", () => Promise.resolve("first"));
    boot({ workflows: [filler, urgent], steps: [], workflowConcurrency: 1, stepConcurrency: 1 });
    await waitUntil(async () => (await completedCount(namespaceId)) >= 5, "the backlog to move");

    const before = await pool.query<{ seq: string | null }>(
      "select max(lease_seq) as seq from tasks",
    );
    const started = await service.startRun(namespaceId, { workflowType: "urgent", priority: 10 });
    const runId = started.run.runId;
    await waitUntil(async () => (await status(runId)) === "COMPLETED", "the urgent run");

    const urgentTask = await pool.query<{ lease_seq: string; leased_at: Date; priority: number }>(
      "select lease_seq, leased_at, priority from tasks where run_id = $1",
      [runId],
    );
    const leased = urgentTask.rows[0];
    expect(leased?.priority).toBe(10);
    const overtaking = await pool.query<{ count: string }>(
      `select count(*) from tasks
       where run_id <> $1 and lease_seq > $2::bigint and lease_seq < $3::bigint`,
      [runId, before.rows[0]?.seq ?? "0", leased?.lease_seq],
    );
    expect(Number(overtaking.rows[0]?.count)).toBeLessThanOrEqual(2);
    const slotFreed = await pool.query<{ freed_at: Date }>(
      `select updated_at as freed_at from tasks
       where run_id <> $1 and lease_seq < $2::bigint and state = 'COMPLETED'
       order by lease_seq desc limit 1`,
      [runId, leased?.lease_seq],
    );
    const waitedMs =
      (leased?.leased_at.getTime() ?? 0) - (slotFreed.rows[0]?.freed_at.getTime() ?? 0);
    expect(waitedMs).toBeLessThan(POLL_INTERVAL_MS);
    expect(await completedCount(namespaceId)).toBeLessThan(9_000);
    expect(errors).toEqual([]);
  });

  it("finishes a namespace's 10 tasks before another namespace's 10,000 older ones", async () => {
    const big = await createNamespace("big");
    const small = await createNamespace("small");
    await seedFillers(big, 10_000, 600);
    await seedFillers(small, 10, 1);
    boot({ workflows: [filler], steps: [], workflowConcurrency: 2, stepConcurrency: 1 });

    await waitUntil(async () => (await completedCount(small)) === 10, "the small namespace");

    expect(await completedCount(big)).toBeLessThanOrEqual(20);
    expect(errors).toEqual([]);
  });

  it("decides workflows while long steps fill the step pool", async () => {
    await createNamespace("default");
    const namespaceId = (
      await pool.query<{ id: string }>("select id from namespaces where name = 'default'")
    ).rows[0]?.id;
    let running = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = defineStep<unknown, string>("slow", {
      handler: async () => {
        running += 1;
        await gate;
        return "slow done";
      },
    });
    const long = defineWorkflow("long", (ctx) => ctx.step<string>("slow", {}));
    const quick = defineWorkflow("quick", () => Promise.resolve("decided"));
    boot({
      workflows: [long, quick],
      steps: [slow],
      workflowConcurrency: 1,
      stepConcurrency: 2,
      pollIntervalMs: 10,
    });
    const longRuns = await Promise.all(
      [1, 2].map(async () => {
        const started = await service.startRun(namespaceId ?? "", { workflowType: "long" });
        return started.run.runId;
      }),
    );
    await waitUntil(() => Promise.resolve(running === 2), "both slow steps to start");

    const thirdLong = await service.startRun(namespaceId ?? "", { workflowType: "long" });
    await waitUntil(async () => {
      const queued = await pool.query(
        "select 1 from tasks where run_id = $1 and task_type = 'STEP_TASK'",
        [thirdLong.run.runId],
      );
      return queued.rowCount === 1;
    }, "the third long run's decision");
    const quickRun = await service.startRun(namespaceId ?? "", { workflowType: "quick" });
    await waitUntil(
      async () => (await status(quickRun.run.runId)) === "COMPLETED",
      "the quick run to complete",
    );

    expect(running).toBe(2);
    expect(await Promise.all(longRuns.map(status))).toEqual(["RUNNING", "RUNNING"]);
    release();
    for (const runId of [...longRuns, thirdLong.run.runId]) {
      await waitUntil(async () => (await status(runId)) === "COMPLETED", `run ${runId}`);
    }
    expect(running).toBe(3);
    expect(errors).toEqual([]);
  });
});
