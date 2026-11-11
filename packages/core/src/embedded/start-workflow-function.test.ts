import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createIsolatedDatabase,
  createIsolatedSchema,
  type IsolatedSchema,
} from "../db/test-harness.ts";

describe("the start_workflow SQL function", () => {
  let engine: IsolatedSchema;
  let app: IsolatedSchema;

  beforeAll(async () => {
    engine = await createIsolatedDatabase();
    app = await createIsolatedSchema();
    await app.pool.query("create table orders (id text primary key, total integer not null)");
    await app.pool.query(`
      create function enqueue_fulfilment() returns trigger language plpgsql as $$
      begin
        perform "${engine.schema}".start_workflow(
          'fulfil',
          jsonb_build_object('orderId', new.id),
          idempotency_key => 'order:' || new.id
        );
        return new;
      end;
      $$`);
    await app.pool.query(
      "create trigger orders_enqueue after insert on orders for each row execute function enqueue_fulfilment()",
    );
  });

  afterAll(async () => {
    await app.close();
    await engine.close();
  });

  beforeEach(async () => {
    await app.pool.query("truncate orders");
    await engine.pool.query("truncate namespaces cascade");
  });

  async function runsFor(orderId: string): Promise<{ id: string; status: string }[]> {
    const result = await engine.pool.query<{ id: string; status: string }>(
      "select id, status from workflow_runs where input ->> 'orderId' = $1",
      [orderId],
    );
    return result.rows;
  }

  it("starts a run with its first event and task from a trigger", async () => {
    await app.pool.query("insert into orders (id, total) values ('t-1', 10)");
    const [run] = await runsFor("t-1");
    expect(run?.status).toBe("RUNNING");
    const events = await engine.pool.query<{ payload: unknown }>(
      "select payload from run_events where run_id = $1 order by sequence_number",
      [run?.id],
    );
    expect(events.rows.map((row) => row.payload)).toEqual([
      { type: "run_started", workflowType: "fulfil", input: { orderId: "t-1" } },
    ]);
    const tasks = await engine.pool.query<{ task_type: string; queue_name: string }>(
      "select task_type, queue_name from tasks where run_id = $1",
      [run?.id],
    );
    expect(tasks.rows).toEqual([{ task_type: "WORKFLOW_TASK", queue_name: "default" }]);
  });

  it("leaves nothing behind when the inserting transaction rolls back", async () => {
    const client = await app.pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into orders (id, total) values ('t-2', 20)");
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect(await runsFor("t-2")).toEqual([]);
    const tasks = await engine.pool.query("select 1 from tasks");
    expect(tasks.rowCount).toBe(0);
  });

  it("returns the same run for a repeated idempotency key and rejects a different request", async () => {
    const call = `select "${engine.schema}".start_workflow($1, $2::jsonb, $3) as id`;
    const first = await app.pool.query<{ id: string }>(call, ["fulfil", '{"n":1}', "k-1"]);
    const again = await app.pool.query<{ id: string }>(call, ["fulfil", '{"n":1}', "k-1"]);
    expect(again.rows[0]?.id).toBe(first.rows[0]?.id);
    await expect(app.pool.query(call, ["refund", '{"n":1}', "k-1"])).rejects.toThrow(
      /already started run/,
    );
    await expect(app.pool.query(call, ["", "null", null])).rejects.toThrow(/must not be empty/);
  });
});
