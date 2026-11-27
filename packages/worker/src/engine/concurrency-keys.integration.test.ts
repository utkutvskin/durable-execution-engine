import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInvariantChecker,
  createPostgresEventStore,
  defineStep,
  defineWorkflow,
  readConcurrencyBacklog,
  readRunConcurrency,
  type Pool,
} from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createSeverablePool } from "../chaos/severable-pool.ts";
import { createShiftableClock, type ShiftableClock } from "../chaos/world.ts";
import { startEngine, type Engine, type EngineOptions } from "./runtime.ts";

interface Order {
  readonly customer: string;
  readonly index: number;
}

const VISIBILITY_TIMEOUT_MS = 30_000;

async function yieldTurns(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("concurrency keys in the engine", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let service: RunService;
  let clock: ShiftableClock;
  let namespaceId: string;
  const engines: Engine[] = [];
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
    const created = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
    clock = createShiftableClock();
    errors.length = 0;
  });

  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.stop();
    }
  });

  function boot(
    options: Omit<EngineOptions, "pool" | "onError" | "clock">,
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
      ...options,
      onError: (error) => {
        errors.push(error);
      },
    });
    engines.push(engine);
    return engine;
  }

  async function start(workflowType: string, input: unknown): Promise<string> {
    const started = await service.startRun(namespaceId, { workflowType, input });
    return started.run.runId;
  }

  async function status(runId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.status ?? "missing";
  }

  async function allCompleted(runIds: readonly string[]): Promise<boolean> {
    const result = await pool.query<{ count: string }>(
      "select count(*) from workflow_runs where id = any($1::uuid[]) and status = 'COMPLETED'",
      [runIds],
    );
    return Number(result.rows[0]?.count) === runIds.length;
  }

  async function check(runIds: readonly string[]) {
    return createInvariantChecker(pool, createPostgresEventStore(pool)).check({
      runIds,
      at: clock.now(),
    });
  }

  it("never has two runs of one key running at limit 1, with 50 runs over 5 keys", async () => {
    const active = new Map<string, Set<number>>();
    let overlaps = 0;
    let maxActive = 0;
    const enter = defineStep<Order, string>("enter", {
      handler: async (order) => {
        const running = active.get(order.customer) ?? new Set<number>();
        running.add(order.index);
        active.set(order.customer, running);
        maxActive = Math.max(maxActive, running.size);
        if (running.size > 1) {
          overlaps += 1;
        }
        await yieldTurns(5);
        return order.customer;
      },
    });
    const leave = defineStep<Order, string>("leave", {
      handler: async (order) => {
        await yieldTurns(5);
        active.get(order.customer)?.delete(order.index);
        return order.customer;
      },
    });
    const checkout = defineWorkflow<Order, string>(
      "checkout",
      async (ctx, order) => {
        await ctx.step(enter, order);
        return ctx.step(leave, order);
      },
      { concurrency: { key: (order) => order.customer, limit: 1 } },
    );
    boot({ workflows: [checkout], steps: [enter, leave], workflowConcurrency: 4 });

    const runIds = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        start("checkout", { customer: `customer-${String(index % 5)}`, index }),
      ),
    );
    await waitUntil(() => allCompleted(runIds), "all 50 runs");

    expect(overlaps).toBe(0);
    expect(maxActive).toBe(1);
    const report = await check(runIds);
    expect(report.violations).toEqual([]);
    const history = await pool.query<{ keys: string; runs: string }>(
      `select count(distinct concurrency_key) as keys, count(distinct run_id) as runs
       from concurrency_slot_history where scope = 'run'`,
    );
    expect(history.rows[0]).toEqual({ keys: "5", runs: "50" });
    expect(errors).toEqual([]);
  });

  it("frees the slot of a sleeping run, so another run of its key completes meanwhile", async () => {
    const sleepy = defineWorkflow<Order, string>(
      "sleepy",
      async (ctx, order) => {
        if (order.index === 0) {
          await ctx.sleep(3_600_000);
        }
        return `done ${String(order.index)}`;
      },
      { concurrency: { key: (order) => order.customer, limit: 1 } },
    );
    boot({ workflows: [sleepy], steps: [] });
    const sleeper = await start("sleepy", { customer: "c", index: 0 });
    await waitUntil(async () => {
      const timers = await pool.query("select 1 from timers where run_id = $1", [sleeper]);
      return timers.rowCount === 1;
    }, "the run to sleep");
    await waitUntil(
      async () => (await readRunConcurrency(pool, sleeper))?.holdsSlot === false,
      "the sleeper to free its slot",
    );

    const other = await start("sleepy", { customer: "c", index: 1 });
    await waitUntil(async () => (await status(other)) === "COMPLETED", "the second run");

    expect(await status(sleeper)).toBe("RUNNING");
    clock.shift(3_600_001);
    await waitUntil(async () => (await status(sleeper)) === "COMPLETED", "the sleeper");
    expect((await check([sleeper, other])).violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("releases the step slot of a hanging task that a graceful stop drops", async () => {
    let release: () => void = () => undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: number[] = [];
    let hanging = true;
    const charge = defineStep<Order, string>("charge", {
      handler: async (order) => {
        calls.push(order.index);
        if (hanging) {
          await hang;
        }
        return `charged ${String(order.index)}`;
      },
      concurrency: { key: (order) => order.customer, limit: 1 },
    });
    const pay = defineWorkflow<Order, string>("pay", (ctx, order) => ctx.step(charge, order));
    const first = boot({ workflows: [pay], steps: [charge], shutdownTimeoutMs: 50 });
    const runIds = [
      await start("pay", { customer: "c", index: 0 }),
      await start("pay", { customer: "c", index: 1 }),
    ];
    await waitUntil(() => Promise.resolve(calls.length === 1), "the first charge to start");

    const stopped = await first.stop();
    engines.splice(engines.indexOf(first), 1);
    expect(stopped.dropped).toBe(1);
    const dropped = await pool.query<{ state: string; slots: string }>(
      `select task.state,
              (select count(*) from concurrency_slots where scope = 'step') as slots
       from tasks task where task.run_id = $1 and task.task_type = 'STEP_TASK'`,
      [runIds[calls[0] ?? 0]],
    );
    expect(dropped.rows).toEqual([{ state: "PENDING", slots: "0" }]);
    hanging = false;
    boot({ workflows: [pay], steps: [charge] });
    await waitUntil(() => allCompleted(runIds), "both payments without the lease expiring");
    release();

    expect(calls.slice(1).sort()).toEqual([0, 1]);
    expect((await check(runIds)).violations).toEqual([]);
  });

  it("reclaims a crashed worker's step slot with its lease", async () => {
    let release: () => void = () => undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: number[] = [];
    let crashed = true;
    const charge = defineStep<Order, string>("charge", {
      handler: async (order) => {
        calls.push(order.index);
        if (crashed) {
          await hang;
        }
        return `charged ${String(order.index)}`;
      },
      concurrency: { key: (order) => order.customer, limit: 1 },
    });
    const pay = defineWorkflow<Order, string>("pay", (ctx, order) => ctx.step(charge, order));
    const crashing = createSeverablePool(pool);
    const first = boot({ workflows: [pay], steps: [charge], shutdownTimeoutMs: 50 }, crashing.pool);
    const runIds = [
      await start("pay", { customer: "c", index: 0 }),
      await start("pay", { customer: "c", index: 1 }),
    ];
    await waitUntil(() => Promise.resolve(calls.length === 1), "the first charge to start");
    await waitUntil(async () => {
      const backlog = await readConcurrencyBacklog(pool, { clock });
      return backlog.some((entry) => entry.scope === "step" && entry.queued === 1);
    }, "the second charge to queue for the slot");
    expect(calls).toHaveLength(1);

    crashing.sever();
    await first.stop();
    engines.splice(engines.indexOf(first), 1);
    const held = await pool.query<{ state: string; slots: string }>(
      `select task.state,
              (select count(*) from concurrency_slots where scope = 'step') as slots
       from tasks task where task.run_id = $1 and task.task_type = 'STEP_TASK'`,
      [runIds[calls[0] ?? 0]],
    );
    expect(held.rows).toEqual([{ state: "LEASED", slots: "1" }]);
    crashed = false;
    boot({ workflows: [pay], steps: [charge] });
    await yieldTurns(50);
    expect(calls).toHaveLength(1);
    clock.shift(VISIBILITY_TIMEOUT_MS + 1);
    await waitUntil(() => allCompleted(runIds), "both payments");
    release();

    expect(calls.slice(1).sort()).toEqual([0, 1]);
    expect((await check(runIds)).violations).toEqual([]);
  });
});
