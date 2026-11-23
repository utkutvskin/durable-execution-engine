import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInvariantChecker,
  createPostgresEventStore,
  defineStep,
  defineWorkflow,
  setNamespaceRetention,
  type Pool,
} from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createShiftableClock, type ShiftableClock } from "../chaos/world.ts";
import { startEngine, type Engine, type EngineOptions } from "./runtime.ts";

const HOUR_MS = 3_600_000;
const RETAINED_TABLES = [
  "workflow_task_results",
  "step_attempts",
  "timers",
  "schedule_triggers",
  "dead_letters",
  "all_tasks",
  "concurrency_slot_history",
];

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("retention in the engine", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let service: RunService;
  let clock: ShiftableClock;
  let namespaceId: string;
  const engines: Engine[] = [];
  const errors: unknown[] = [];
  const failedOnce = new Set<number>();

  const charge = defineStep<{ index: number }, number>("charge", {
    retry: { initialIntervalMs: 1, backoffCoefficient: 1, jitter: 0, maxAttempts: 3 },
    handler: ({ index }) => {
      if (!failedOnce.has(index)) {
        failedOnce.add(index);
        throw new Error(`card ${String(index)} declined once`);
      }
      return index * 10;
    },
  });
  const order = defineWorkflow(
    "order",
    async (ctx, input: { index: number }) => {
      const charged = await ctx.step<number>("charge", input);
      await ctx.sleep(1);
      return charged + 1;
    },
    { concurrency: { key: () => "tenant", limit: 4 } },
  );
  const held = defineWorkflow("held", async (ctx, input: { index: number }) => {
    const charged = await ctx.step<number>("charge", input);
    const go = await ctx.waitForSignal<{ bonus: number }>("go");
    return charged + go.bonus;
  });

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
    const created = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
    clock = createShiftableClock();
    errors.length = 0;
    failedOnce.clear();
  });

  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.stop();
    }
  });

  function boot(
    options: Omit<EngineOptions, "pool" | "onError" | "clock" | "workflows" | "steps">,
  ) {
    const engine = startEngine({
      pool,
      clock,
      workflows: [order, held],
      steps: [charge],
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      stickyRouting: false,
      shutdownTimeoutMs: 2_000,
      ...options,
      onError: (error) => {
        errors.push(error);
      },
    });
    engines.push(engine);
    return engine;
  }

  async function start(workflowType: string, index: number): Promise<string> {
    const started = await service.startRun(namespaceId, { workflowType, input: { index } });
    return started.run.runId;
  }

  async function count(sql: string, values: unknown[]): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count);
  }

  async function rowsOutside(runIds: readonly string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of RETAINED_TABLES) {
      counts[table] = await count(
        `select count(*) from ${table} where run_id is not null and not (run_id = any($1::uuid[]))`,
        [runIds],
      );
    }
    return counts;
  }

  async function fingerprint(runIds: readonly string[]): Promise<string[]> {
    const digests: string[] = [];
    for (const table of [...RETAINED_TABLES, "run_events", "step_results", "workflow_runs"]) {
      const column = table === "workflow_runs" ? "id" : "run_id";
      const result = await pool.query<{ digest: string | null }>(
        `select md5(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text)) as digest
         from ${table} t where ${column} = any($1::uuid[])`,
        [runIds],
      );
      digests.push(`${table}:${result.rows[0]?.digest ?? "empty"}`);
    }
    return digests;
  }

  it("purges closed runs once their retention passed, and the open runs still complete", async () => {
    boot({ retention: { closedRunRetentionMs: HOUR_MS, finishedTaskGraceMs: 0 } });
    const closed = await Promise.all(
      Array.from({ length: 30 }, (_, index) => start("order", index)),
    );
    const open = await Promise.all(
      Array.from({ length: 3 }, (_, index) => start("held", 100 + index)),
    );
    await waitUntil(
      async () =>
        (await count(
          "select count(*) from workflow_runs where id = any($1::uuid[]) and status = 'COMPLETED'",
          [closed],
        )) === closed.length,
      "the orders to complete",
    );
    await waitUntil(
      async () =>
        (await count("select count(*) from step_results where run_id = any($1::uuid[])", [
          open,
        ])) === open.length,
      "the held runs to charge",
    );
    await waitUntil(
      async () => (await count("select count(*) from tasks where state = 'COMPLETED'", [])) === 0,
      "finished tasks to retire",
    );
    expect(await count("select count(*) from workflow_runs where purged_at is not null", [])).toBe(
      0,
    );
    const closedRows = await rowsOutside(open);
    expect(closedRows["step_attempts"]).toBe(closed.length);
    expect(closedRows["timers"]).toBe(closed.length);
    expect(closedRows["workflow_task_results"]).toBeGreaterThanOrEqual(3 * closed.length);
    expect(closedRows["all_tasks"]).toBeGreaterThanOrEqual(4 * closed.length);
    expect(closedRows["concurrency_slot_history"]).toBeGreaterThanOrEqual(closed.length);
    const before = await fingerprint(open);

    clock.shift(HOUR_MS);
    await waitUntil(
      async () =>
        (await count("select count(*) from workflow_runs where purged_at is not null", [])) ===
        closed.length,
      "the closed runs to be purged",
    );

    expect(await rowsOutside(open)).toEqual(
      Object.fromEntries(RETAINED_TABLES.map((table) => [table, 0])),
    );
    expect(await fingerprint(open)).toEqual(before);
    for (const runId of open) {
      await service.signalRun(namespaceId, runId, "go", { bonus: 7 });
    }
    await waitUntil(
      async () =>
        (await count(
          "select count(*) from workflow_runs where id = any($1::uuid[]) and status = 'COMPLETED'",
          [open],
        )) === open.length,
      "the held runs to complete",
    );
    const results = await pool.query<{ result: number }>(
      "select result from workflow_runs where id = any($1::uuid[]) order by result",
      [open],
    );
    expect(results.rows.map((row) => row.result)).toEqual([1007, 1017, 1027]);
    const report = await createInvariantChecker(pool, createPostgresEventStore(pool)).check({
      runIds: open,
    });
    expect(report.violations).toEqual([]);
    expect(errors.filter((error) => !String(error).includes("declined once"))).toEqual([]);
  });

  it("keeps closed runs without a retention and retires their tasks only", async () => {
    boot({ retention: { finishedTaskGraceMs: 0 } });
    const runId = await start("order", 1);
    await waitUntil(
      async () =>
        (await count("select count(*) from workflow_runs where id = $1 and status = 'COMPLETED'", [
          runId,
        ])) === 1,
      "the order to complete",
    );
    await waitUntil(
      async () => (await count("select count(*) from tasks", [])) === 0,
      "the tasks to retire",
    );
    clock.shift(365 * 24 * HOUR_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(await count("select count(*) from task_history where run_id = $1", [runId])).toBe(4);
    expect(await count("select count(*) from step_attempts where run_id = $1", [runId])).toBe(1);
    await setNamespaceRetention(pool, namespaceId, 0);
    await waitUntil(
      async () =>
        (await count("select count(*) from task_history where run_id = $1", [runId])) === 0,
      "the namespace retention to apply",
    );
  });

  it("leaves completed tasks in place with retention turned off", async () => {
    boot({ retention: false });
    const runId = await start("order", 2);
    await waitUntil(
      async () =>
        (await count("select count(*) from workflow_runs where id = $1 and status = 'COMPLETED'", [
          runId,
        ])) === 1,
      "the order to complete",
    );
    clock.shift(HOUR_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(
      await count("select count(*) from tasks where run_id = $1 and state = 'COMPLETED'", [runId]),
    ).toBeGreaterThan(0);
    expect(await count("select count(*) from task_history", [])).toBe(0);
  });
});
