import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BATCH_WORKFLOW_TYPE,
  createInvariantChecker,
  createPostgresEventStore,
  defineStep,
  defineWorkflow,
  jsonCodec,
  listBatchTargets,
  NonRetryableError,
  readBatchOperation,
  startBatchOperationOnClient,
  withTransaction,
  type BatchOperation,
  type Pool,
  type StartBatchInput,
} from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createSeverablePool } from "../chaos/severable-pool.ts";
import { createShiftableClock, type ShiftableClock } from "../chaos/world.ts";
import { startEngine, type Engine, type EngineOptions } from "./runtime.ts";

const VISIBILITY_TIMEOUT_MS = 30_000;

async function waitUntil(
  condition: () => Promise<boolean>,
  what: string,
  attempts = 3000,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("batch operations in the engine", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let service: RunService;
  let clock: ShiftableClock;
  let namespaceId: string;
  const engines: Engine[] = [];
  const chargeCalls: string[] = [];
  let chargeIsBroken = false;

  const charge = defineStep<{ readonly id: string }, string>("charge", {
    handler: (input) => {
      chargeCalls.push(input.id);
      if (chargeIsBroken) {
        return Promise.reject(new NonRetryableError("charge has a bug"));
      }
      return Promise.resolve(`charged ${input.id}`);
    },
    retry: { maxAttempts: 1 },
  });
  const flaky = defineStep<{ readonly id: string }, string>("flaky", {
    handler: (input) => {
      if (chargeIsBroken) {
        return Promise.reject(new Error("flaky is down"));
      }
      return Promise.resolve(`flaked ${input.id}`);
    },
    retry: { maxAttempts: 1 },
  });
  const parked = defineWorkflow<{ readonly id: string }, string>("parked", async (ctx) => {
    const word = await ctx.waitForSignal<string>("go");
    return `went ${word}`;
  });
  const paying = defineWorkflow<{ readonly id: string }, string>("paying", (ctx, input) =>
    ctx.step(charge, input),
  );
  const retrying = defineWorkflow<{ readonly id: string }, string>("retrying", (ctx, input) =>
    ctx.step(flaky, input),
  );

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
    await pool.query("truncate run_events");
    const created = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
    clock = createShiftableClock();
    chargeCalls.length = 0;
    chargeIsBroken = false;
  });

  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.stop();
    }
  });

  function boot(
    options: Partial<Omit<EngineOptions, "pool" | "clock">> = {},
    enginePool: Pool = pool,
  ): Engine {
    const engine = startEngine({
      pool: enginePool,
      clock,
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      stickyRouting: false,
      visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS,
      shutdownTimeoutMs: 2_000,
      workflows: [parked, paying, retrying],
      steps: [charge, flaky],
      ...options,
    });
    engines.push(engine);
    return engine;
  }

  async function startMany(workflowType: string, count: number, kind: string): Promise<string[]> {
    const runIds: string[] = [];
    for (let offset = 0; offset < count; offset += 50) {
      const chunk = await Promise.all(
        Array.from({ length: Math.min(50, count - offset) }, async (_, index) => {
          const started = await service.startRun(namespaceId, {
            workflowType,
            input: { id: `${kind}-${String(offset + index)}` },
            searchAttributes: { kind },
          });
          return started.run.runId;
        }),
      );
      runIds.push(...chunk);
    }
    return runIds;
  }

  async function startBatch(
    input: Omit<StartBatchInput, "namespaceId" | "queueName">,
  ): Promise<BatchOperation> {
    return withTransaction(pool, (client) =>
      startBatchOperationOnClient(client, jsonCodec, {
        ...input,
        namespaceId,
        queueName: "default",
      }),
    );
  }

  async function batchDone(batchId: string): Promise<boolean> {
    return (await readBatchOperation(pool, batchId))?.status === "COMPLETED";
  }

  async function countByStatus(runIds: readonly string[]): Promise<Record<string, number>> {
    const result = await pool.query<{ status: string; count: string }>(
      "select status, count(*) from workflow_runs where id = any($1::uuid[]) group by status",
      [runIds],
    );
    return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
  }

  it("terminates 1,000 runs exactly once each, across a worker killed in the middle of the batch", async () => {
    const runIds = await startMany("parked", 1000, "doomed");
    const crashing = createSeverablePool(pool);
    const first = boot({ onError: () => undefined }, crashing.pool);
    const batch = await startBatch({
      operation: "terminate",
      query: "kind = 'doomed'",
      reason: "cleanup",
      pageSize: 50,
    });
    expect(batch.total).toBe(1000);

    await waitUntil(
      async () => ((await readBatchOperation(pool, batch.batchId))?.applied ?? 0) >= 200,
      "the batch to get going",
    );
    crashing.sever();
    await first.stop();
    engines.splice(engines.indexOf(first), 1);
    const atKill = await readBatchOperation(pool, batch.batchId);
    expect(atKill?.applied).toBeGreaterThanOrEqual(200);
    expect(atKill?.remaining).toBeGreaterThan(0);

    const errors: unknown[] = [];
    boot({ onError: (error) => errors.push(error) });
    clock.shift(VISIBILITY_TIMEOUT_MS + 1);
    await waitUntil(() => batchDone(batch.batchId), "the batch to finish", 6000);

    const done = await readBatchOperation(pool, batch.batchId);
    expect(done).toMatchObject({ applied: 1000, skipped: 0, remaining: 0, status: "COMPLETED" });
    expect(await countByStatus(runIds)).toEqual({ TERMINATED: 1000 });
    const terminations = await pool.query<{ runs: string; events: string }>(
      `select count(distinct run_id) as runs, count(*) as events from run_events
       where run_id = any($1::uuid[]) and event_type = 'run_terminated'`,
      [runIds],
    );
    expect(terminations.rows[0]).toEqual({ runs: "1000", events: "1000" });
    const checker = createInvariantChecker(pool, createPostgresEventStore(pool));
    const report = await checker.check({ runIds: [...runIds, batch.runId], at: clock.now() });
    expect(report.violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("signals only the runs its query matches, once each, and skips the closed ones", async () => {
    boot();
    const matching = await startMany("parked", 6, "blue");
    const others = await startMany("parked", 4, "green");
    const closed = matching.slice(0, 2);
    for (const runId of closed) {
      await service.terminateRun(namespaceId, runId, "closed before the batch");
    }

    const batch = await startBatch({
      operation: "signal",
      query: "kind = 'blue'",
      signal: { name: "go", payload: "now" },
    });
    await waitUntil(() => batchDone(batch.batchId), "the batch");

    expect(await readBatchOperation(pool, batch.batchId)).toMatchObject({
      total: 6,
      applied: 4,
      skipped: 2,
    });
    await waitUntil(
      async () => (await countByStatus(matching.slice(2)))["COMPLETED"] === 4,
      "the signalled runs",
    );
    expect(await countByStatus(others)).toEqual({ RUNNING: 4 });
    const targets = await listBatchTargets(pool, batch.batchId);
    expect(
      targets
        .filter((target) => target.state === "SKIPPED")
        .map((target) => target.runId)
        .sort(),
    ).toEqual([...closed].sort());
    expect(targets.find((target) => target.state === "SKIPPED")?.detail).toMatch(/TERMINATED/);
  });

  it("does not target its own batch runs or runs of another namespace", async () => {
    boot();
    const first = await startBatch({ operation: "cancel", query: "" });
    await waitUntil(() => batchDone(first.batchId), "the empty batch");
    const other = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('other') returning id",
    );
    await createRunService(pool, { queueName: "default" }).startRun(other.rows[0]?.id ?? "", {
      workflowType: "parked",
      input: { id: "elsewhere" },
    });

    const second = await startBatch({ operation: "cancel", query: "" });
    await waitUntil(() => batchDone(second.batchId), "the second batch");

    expect(first.total).toBe(0);
    expect(second.total).toBe(0);
    const types = await pool.query<{ workflow_type: string }>(
      "select distinct workflow_type from workflow_runs where namespace_id = $1",
      [namespaceId],
    );
    expect(types.rows).toEqual([{ workflow_type: BATCH_WORKFLOW_TYPE }]);
  });

  it("resets failed runs to their failed step after a fix", async () => {
    chargeIsBroken = true;
    boot();
    const failing = await startMany("paying", 3, "broken");
    await waitUntil(async () => (await countByStatus(failing))["FAILED"] === 3, "the runs to fail");
    chargeIsBroken = false;

    const batch = await startBatch({
      operation: "reset",
      query: "kind = 'broken' and status = 'FAILED'",
      resetPoint: { kind: "failed-step" },
    });
    await waitUntil(() => batchDone(batch.batchId), "the reset batch");

    const targets = await listBatchTargets(pool, batch.batchId);
    expect(targets.map((target) => target.state)).toEqual(["APPLIED", "APPLIED", "APPLIED"]);
    const resets = await pool.query<{ id: string }>(
      "select id from workflow_runs where reset_from_run_id = any($1::uuid[])",
      [failing],
    );
    expect(resets.rows).toHaveLength(3);
    await waitUntil(
      async () => (await countByStatus(resets.rows.map((row) => row.id)))["COMPLETED"] === 3,
      "the reset runs",
    );
    expect(chargeCalls).toHaveLength(6);
  });

  it("requeues each dead-lettered step of the runs it targets once, skipping runs without one", async () => {
    chargeIsBroken = true;
    boot();
    const stuck = await startMany("retrying", 3, "stuck");
    const idle = await startMany("parked", 2, "stuck");
    await waitUntil(async () => {
      const letters = await pool.query("select 1 from dead_letters where requeued_at is null");
      return letters.rowCount === 3;
    }, "the dead letters");
    chargeIsBroken = false;

    const batch = await startBatch({ operation: "requeue", query: "kind = 'stuck'" });
    await waitUntil(() => batchDone(batch.batchId), "the requeue batch");

    expect(await readBatchOperation(pool, batch.batchId)).toMatchObject({
      applied: 3,
      skipped: 2,
    });
    const letters = await pool.query<{ run_id: string; requeued: boolean }>(
      "select run_id, requeued_at is not null as requeued from dead_letters order by run_id",
    );
    expect(letters.rows).toEqual(
      [...stuck].sort().map((runId) => ({ run_id: runId, requeued: true })),
    );
    const requeued = await pool.query<{ count: string }>(
      `select count(*) from all_tasks
       where run_id = any($1::uuid[]) and task_type = 'STEP_TASK' and payload ? 'attemptOffset'`,
      [stuck],
    );
    expect(requeued.rows[0]?.count).toBe("3");
    expect(await countByStatus(idle)).toEqual({ RUNNING: 2 });
  });

  it("applies no more than its rate allows until the clock moves on", async () => {
    boot();
    await startMany("parked", 30, "slow");
    const batch = await startBatch({
      operation: "cancel",
      query: "kind = 'slow'",
      runsPerSecond: 10,
    });
    expect(batch).toMatchObject({ pageSize: 10, pageIntervalMs: 1000 });

    await waitUntil(
      async () => ((await readBatchOperation(pool, batch.batchId))?.applied ?? 0) === 10,
      "the first page",
    );
    await waitUntil(
      async () =>
        (await pool.query("select 1 from timers where run_id = $1", [batch.runId])).rowCount === 1,
      "the pause between pages",
    );
    expect((await readBatchOperation(pool, batch.batchId))?.applied).toBe(10);
    clock.shift(1000);
    await waitUntil(
      async () => ((await readBatchOperation(pool, batch.batchId))?.applied ?? 0) === 20,
      "the second page",
    );
    clock.shift(1000);
    await waitUntil(() => batchDone(batch.batchId), "the batch");
    expect(await readBatchOperation(pool, batch.batchId)).toMatchObject({ applied: 30 });
  });
});
