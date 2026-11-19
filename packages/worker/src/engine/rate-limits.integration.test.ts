import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineStep, defineWorkflow, type Pool } from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createShiftableClock, type ShiftableClock } from "../chaos/world.ts";
import { startEngine, type Engine, type EngineOptions } from "./runtime.ts";

interface Call {
  readonly tenant: string;
  readonly index: number;
}

const PERIOD_MS = 60_000;

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("shared rate limits in the engine", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let clock: ShiftableClock;
  let service: RunService;
  let namespaceId: string;
  const engines: Engine[] = [];
  const errors: unknown[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await pool.query("truncate namespaces cascade");
    await pool.query("truncate rate_limit_admissions");
    const created = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
    clock = createShiftableClock();
    service = createRunService(pool, { queueName: "default" });
    errors.length = 0;
  });

  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.stop();
    }
  });

  function boot(options: Omit<EngineOptions, "pool" | "onError" | "clock">): Engine {
    const engine = startEngine({
      pool,
      clock,
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

  async function start(workflowType: string, input: unknown): Promise<string> {
    return (await service.startRun(namespaceId, { workflowType, input })).run.runId;
  }

  async function completed(runIds: readonly string[]): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "select count(*) from workflow_runs where id = any($1::uuid[]) and status = 'COMPLETED'",
      [runIds],
    );
    return Number(result.rows[0]?.count);
  }

  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }

  it("lets two engines together run no more steps of a key than its limit per period", async () => {
    const calls: Call[] = [];
    const callApi = defineStep<Call, number>("call-api", {
      handler: (call) => {
        calls.push(call);
        return call.index;
      },
      rateLimit: { limitPerPeriod: 3, periodMs: PERIOD_MS, key: (call) => call.tenant },
    });
    const sync = defineWorkflow<Call, number>("sync", (ctx, call) => ctx.step(callApi, call));
    boot({ workflows: [sync], steps: [callApi] });
    boot({ workflows: [sync], steps: [callApi] });

    const acme = await Promise.all(
      Array.from({ length: 7 }, (_, index) => start("sync", { tenant: "acme", index })),
    );
    const other = await Promise.all(
      Array.from({ length: 2 }, (_, index) => start("sync", { tenant: "other", index })),
    );
    await waitUntil(async () => (await completed(acme)) === 3, "the first window of acme");
    await waitUntil(async () => (await completed(other)) === 2, "the other tenant");
    await settle();
    expect(await completed(acme)).toBe(3);
    expect(calls.filter((call) => call.tenant === "acme")).toHaveLength(3);

    clock.shift(PERIOD_MS);
    await waitUntil(async () => (await completed(acme)) === 6, "the second window of acme");
    await settle();
    expect(await completed(acme)).toBe(6);

    clock.shift(PERIOD_MS);
    await waitUntil(async () => (await completed(acme)) === 7, "the last acme run");
    expect(calls.filter((call) => call.tenant === "acme")).toHaveLength(7);
    expect(calls).toHaveLength(9);
    expect(errors).toEqual([]);
  });

  it("caps the steps of a queue across engines with a queue rate limit", async () => {
    let executed = 0;
    const work = defineStep<number, number>("work", {
      handler: (value) => {
        executed += 1;
        return value;
      },
    });
    const job = defineWorkflow<number, number>("job", (ctx, value) => ctx.step(work, value));
    const queueRateLimit = { limitPerPeriod: 4, periodMs: PERIOD_MS };
    boot({ workflows: [job], steps: [work], queueRateLimit });
    boot({ workflows: [job], steps: [work], queueRateLimit });

    const runIds = await Promise.all(Array.from({ length: 6 }, (_, index) => start("job", index)));
    await waitUntil(async () => (await completed(runIds)) === 4, "the first window");
    await settle();
    expect(executed).toBe(4);
    clock.shift(PERIOD_MS);
    await waitUntil(async () => (await completed(runIds)) === 6, "every run");
    expect(executed).toBe(6);
    expect(errors).toEqual([]);
  });
});
