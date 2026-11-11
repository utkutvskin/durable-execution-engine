import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, defaultMigrationsDir, migrateUp, type Pool } from "@dee/core";
import {
  createIsolatedSchema,
  type IsolatedSchema,
} from "../../../packages/core/src/db/test-harness.ts";
import { startEngine, type Engine } from "../../../packages/worker/src/engine/runtime.ts";
import {
  FULFIL_ORDER,
  createOrderTables,
  installOrderTrigger,
  placeOrder,
  steps,
  workflows,
  type FulfilOrderResult,
} from "./index.ts";

interface RunRow {
  id: string;
  status: string;
  result: unknown;
}

describe("outbox", () => {
  let app: IsolatedSchema;
  let engineSchema: string;
  let enginePool: Pool;
  let engine: Engine | undefined;
  const errors: unknown[] = [];

  beforeAll(async () => {
    app = await createIsolatedSchema();
    engineSchema = `${app.schema}_dee`;
    await migrateUp(app.pool, defaultMigrationsDir, { schema: engineSchema });
    await createOrderTables(app.pool);
    enginePool = createPool(process.env, { schema: engineSchema, max: 4 });
  });

  afterAll(async () => {
    await enginePool.end();
    await app.pool.query(`drop schema if exists "${engineSchema}" cascade`);
    await app.close();
  });

  beforeEach(async () => {
    await app.pool.query("drop trigger if exists orders_start_fulfilment on orders");
    await app.pool.query("truncate order_lines, orders");
    await enginePool.query("truncate namespaces cascade");
    errors.length = 0;
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  function boot(): void {
    engine = startEngine({
      pool: enginePool,
      workflows,
      steps,
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      shutdownTimeoutMs: 2_000,
      onError: (error) => {
        errors.push(error);
      },
    });
  }

  async function runs(): Promise<RunRow[]> {
    const result = await enginePool.query<RunRow>(
      "select id, status, result from workflow_runs order by started_at",
    );
    return result.rows;
  }

  async function engineRowCounts(): Promise<{ runs: number; events: number; tasks: number }> {
    const result = await enginePool.query<{ runs: string; events: string; tasks: string }>(
      `select (select count(*) from workflow_runs) as runs,
              (select count(*) from run_events) as events,
              (select count(*) from tasks) as tasks`,
    );
    const row = result.rows[0];
    return { runs: Number(row?.runs), events: Number(row?.events), tasks: Number(row?.tasks) };
  }

  async function settled(runId: string): Promise<RunRow> {
    await expect
      .poll(async () => (await runs()).find((run) => run.id === runId)?.status, { timeout: 15_000 })
      .not.toBe("RUNNING");
    const found = (await runs()).find((run) => run.id === runId);
    if (found === undefined) {
      throw new Error(`run ${runId} does not exist`);
    }
    return found;
  }

  it("exports one workflow and its two steps", () => {
    expect(workflows.map((workflow) => workflow.workflowType)).toEqual([FULFIL_ORDER]);
    expect(steps.map((step) => step.stepType)).toEqual([
      "outbox.reserve-stock",
      "outbox.send-confirmation",
    ]);
  });

  it("runs a committed order's workflow to completion", async () => {
    boot();
    const runId = await placeOrder(
      app.pool,
      { id: "o-1", customer: "ada", lines: [{ sku: "book", quantity: 2 }] },
      { engineSchema },
    );
    const run = await settled(runId);
    expect(run.status).toBe("COMPLETED");
    expect(run.result).toEqual({
      orderId: "o-1",
      reservation: "reservation:o-1",
      confirmation: "confirmation:o-1",
    } satisfies FulfilOrderResult);
    expect(errors).toEqual([]);
  });

  it("leaves no order, run, event or task when a later write fails", async () => {
    boot();
    await expect(
      placeOrder(
        app.pool,
        {
          id: "o-2",
          customer: "grace",
          lines: [
            { sku: "book", quantity: 1 },
            { sku: "pen", quantity: 0 },
          ],
        },
        { engineSchema },
      ),
    ).rejects.toThrow(/check constraint/);
    expect(await engineRowCounts()).toEqual({ runs: 0, events: 0, tasks: 0 });
    const orders = await app.pool.query("select 1 from orders");
    expect(orders.rowCount).toBe(0);
  });

  it("keeps one order and one run when the same order is placed twice", async () => {
    const order = { id: "o-3", customer: "alan", lines: [{ sku: "book", quantity: 1 }] };
    await placeOrder(app.pool, order, { engineSchema });
    await expect(placeOrder(app.pool, order, { engineSchema })).rejects.toThrow(/duplicate key/);
    expect((await runs()).length).toBe(1);
  });

  it("starts the fulfilment from a trigger through the SQL function", async () => {
    await installOrderTrigger(app.pool, engineSchema);
    boot();
    await app.pool.query("insert into orders (id, customer) values ('o-4', 'edsger')");
    const [run] = await runs();
    expect(run).toBeDefined();
    const finished = await settled(run?.id ?? "");
    expect(finished.status).toBe("COMPLETED");
    expect(finished.result).toMatchObject({ orderId: "o-4" });
  });

  it("starts one run when both the trigger and placeOrder start the same order", async () => {
    await installOrderTrigger(app.pool, engineSchema);
    const runId = await placeOrder(
      app.pool,
      { id: "o-5", customer: "barbara", lines: [{ sku: "pen", quantity: 3 }] },
      { engineSchema },
    );
    expect((await runs()).map((run) => run.id)).toEqual([runId]);
  });
});
