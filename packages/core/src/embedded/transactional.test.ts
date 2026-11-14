import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  createIsolatedDatabase,
  createIsolatedSchema,
  type IsolatedSchema,
} from "../db/test-harness.ts";
import { RunNotFoundError, RunNotOpenError } from "../signals/signal-service.ts";
import { RunAlreadyClosedError } from "../cancellation/run-control.ts";
import {
  IdempotencyKeyConflictError,
  NoOpenTransactionError,
  cancelWorkflow,
  signalWorkflow,
  startWorkflow,
} from "./transactional.ts";

interface Counts {
  runs: number;
  events: number;
  tasks: number;
  timers: number;
}

describe("transactional workflow start, signal and cancel", () => {
  let engine: IsolatedSchema;
  let app: IsolatedSchema;

  beforeAll(async () => {
    engine = await createIsolatedDatabase();
    app = await createIsolatedSchema();
    await app.pool.query("create table orders (id text primary key, total integer not null)");
  });

  afterAll(async () => {
    await app.close();
    await engine.close();
  });

  beforeEach(async () => {
    await app.pool.query("truncate orders");
    await engine.pool.query("truncate namespaces cascade");
  });

  async function counts(): Promise<Counts> {
    const result = await engine.pool.query<{
      runs: string;
      events: string;
      tasks: string;
      timers: string;
    }>(
      `select (select count(*) from workflow_runs) as runs,
              (select count(*) from run_events) as events,
              (select count(*) from tasks) as tasks,
              (select count(*) from timers) as timers`,
    );
    const row = result.rows[0];
    return {
      runs: Number(row?.runs),
      events: Number(row?.events),
      tasks: Number(row?.tasks),
      timers: Number(row?.timers),
    };
  }

  async function inAppTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
    outcome: "commit" | "rollback",
  ): Promise<T> {
    const client = await app.pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query(outcome);
      return result;
    } finally {
      client.release();
    }
  }

  async function startCommitted(workflowType = "fulfil"): Promise<string> {
    const started = await inAppTransaction(
      (client) => startWorkflow(client, { workflowType, schema: engine.schema }),
      "commit",
    );
    return started.runId;
  }

  async function eventTypes(runId: string): Promise<string[]> {
    const result = await engine.pool.query<{ event_type: string }>(
      "select event_type from run_events where run_id = $1 order by sequence_number",
      [runId],
    );
    return result.rows.map((row) => row.event_type);
  }

  it("leaves no run, event, task or timer behind when the caller rolls back", async () => {
    await inAppTransaction(async (client) => {
      await client.query("insert into orders (id, total) values ('o-1', 10)");
      await startWorkflow(client, {
        workflowType: "fulfil",
        input: { orderId: "o-1" },
        schema: engine.schema,
        runTimeoutMs: 60_000,
      });
    }, "rollback");
    expect(await counts()).toEqual({ runs: 0, events: 0, tasks: 0, timers: 0 });
    const namespaces = await engine.pool.query("select 1 from namespaces");
    expect(namespaces.rowCount).toBe(0);
    const orders = await app.pool.query("select 1 from orders");
    expect(orders.rowCount).toBe(0);
  });

  it("commits the run, its first event, its task and the caller's row together", async () => {
    const started = await inAppTransaction(async (client) => {
      await client.query("insert into orders (id, total) values ('o-2', 20)");
      return startWorkflow(client, {
        workflowType: "fulfil",
        input: { orderId: "o-2" },
        schema: engine.schema,
        queueName: "orders",
      });
    }, "commit");
    expect(started.created).toBe(true);
    const run = await engine.pool.query<{ status: string; input: unknown; queue_name: string }>(
      "select status, input, queue_name from workflow_runs where id = $1",
      [started.runId],
    );
    expect(run.rows[0]).toEqual({
      status: "RUNNING",
      input: { orderId: "o-2" },
      queue_name: "orders",
    });
    expect(await eventTypes(started.runId)).toEqual(["run_started"]);
    const tasks = await engine.pool.query<{ task_type: string; queue_name: string }>(
      "select task_type, queue_name from tasks where run_id = $1",
      [started.runId],
    );
    expect(tasks.rows).toEqual([{ task_type: "WORKFLOW_TASK", queue_name: "orders" }]);
    const orders = await app.pool.query("select 1 from orders where id = 'o-2'");
    expect(orders.rowCount).toBe(1);
  });

  it("puts the caller's search_path back after using the engine schema", async () => {
    const paths = await inAppTransaction(async (client) => {
      const before = await client.query<{ path: string }>("show search_path");
      await startWorkflow(client, { workflowType: "fulfil", schema: engine.schema });
      const after = await client.query<{ path: string }>("show search_path");
      await client.query("insert into orders (id, total) values ('o-3', 30)");
      return { before: before.rows[0], after: after.rows[0] };
    }, "commit");
    expect(paths.after).toEqual(paths.before);
    expect(String(Object.values(paths.after ?? {})[0])).toContain(app.schema);
  });

  it("refuses a client that has no open transaction and writes nothing", async () => {
    const client = await app.pool.connect();
    try {
      await expect(
        startWorkflow(client, { workflowType: "fulfil", schema: engine.schema }),
      ).rejects.toBeInstanceOf(NoOpenTransactionError);
    } finally {
      client.release();
    }
    expect(await counts()).toEqual({ runs: 0, events: 0, tasks: 0, timers: 0 });
  });

  it("returns the first run for a repeated idempotency key in another transaction", async () => {
    const start = (client: PoolClient): ReturnType<typeof startWorkflow> =>
      startWorkflow(client, {
        workflowType: "fulfil",
        input: { orderId: "o-4" },
        idempotencyKey: "order:o-4",
        schema: engine.schema,
      });
    const first = await inAppTransaction(start, "commit");
    const second = await inAppTransaction(start, "commit");
    expect(second).toEqual({ runId: first.runId, created: false });
    expect((await counts()).runs).toBe(1);
  });

  it("keeps the caller's transaction usable after a rejected start", async () => {
    await inAppTransaction(
      (client) =>
        startWorkflow(client, {
          workflowType: "fulfil",
          input: { orderId: "o-5" },
          idempotencyKey: "order:o-5",
          schema: engine.schema,
        }),
      "commit",
    );
    await inAppTransaction(async (client) => {
      await client.query("insert into orders (id, total) values ('o-5', 50)");
      await expect(
        startWorkflow(client, {
          workflowType: "refund",
          idempotencyKey: "order:o-5",
          schema: engine.schema,
        }),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
      await client.query("insert into orders (id, total) values ('o-6', 60)");
    }, "commit");
    const orders = await app.pool.query<{ id: string }>("select id from orders order by id");
    expect(orders.rows.map((row) => row.id)).toEqual(["o-5", "o-6"]);
    expect((await counts()).runs).toBe(1);
  });

  it("rejects a schema that is not a plain identifier before writing", async () => {
    await inAppTransaction(async (client) => {
      await expect(
        startWorkflow(client, { workflowType: "fulfil", schema: 'x"; drop table orders; --' }),
      ).rejects.toBeInstanceOf(RangeError);
    }, "rollback");
    expect(await counts()).toEqual({ runs: 0, events: 0, tasks: 0, timers: 0 });
  });

  it("signals a run only when the caller commits", async () => {
    const runId = await startCommitted();
    await inAppTransaction(
      (client) =>
        signalWorkflow(client, {
          runId,
          signalName: "paid",
          payload: { amount: 1 },
          schema: engine.schema,
        }),
      "rollback",
    );
    expect(await eventTypes(runId)).toEqual(["run_started"]);
    const receipt = await inAppTransaction(
      (client) =>
        signalWorkflow(client, {
          runId,
          signalName: "paid",
          payload: { amount: 2 },
          schema: engine.schema,
        }),
      "commit",
    );
    expect(receipt.sequenceNumber).toBe(2);
    expect(await eventTypes(runId)).toEqual(["run_started", "signal_received"]);
    const tasks = await engine.pool.query("select 1 from tasks where run_id = $1", [runId]);
    expect(tasks.rowCount).toBe(2);
  });

  it("records a signal with a repeated signal id once", async () => {
    const runId = await startCommitted();
    const send = (): Promise<{ readonly duplicate: boolean }> =>
      inAppTransaction(
        (client) =>
          signalWorkflow(client, {
            runId,
            signalName: "paid",
            signalId: "payment-77",
            schema: engine.schema,
          }),
        "commit",
      );

    const first = await send();
    const second = await send();

    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
    expect(await eventTypes(runId)).toEqual(["run_started", "signal_received"]);
  });

  it("requests cancellation only when the caller commits", async () => {
    const runId = await startCommitted();
    await inAppTransaction(
      (client) => cancelWorkflow(client, { runId, reason: "changed mind", schema: engine.schema }),
      "rollback",
    );
    expect(await eventTypes(runId)).toEqual(["run_started"]);
    const receipt = await inAppTransaction(
      (client) => cancelWorkflow(client, { runId, reason: "changed mind", schema: engine.schema }),
      "commit",
    );
    expect(receipt).toEqual({ requested: true, sequenceNumber: 2 });
    expect(await eventTypes(runId)).toEqual(["run_started", "cancel_requested"]);
  });

  it("reports an unknown or closed run without spoiling the caller's transaction", async () => {
    const runId = await startCommitted();
    await engine.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [runId]);
    await inAppTransaction(async (client) => {
      await expect(
        signalWorkflow(client, {
          runId: "00000000-0000-4000-8000-000000000000",
          signalName: "paid",
          schema: engine.schema,
        }),
      ).rejects.toBeInstanceOf(RunNotFoundError);
      await expect(
        signalWorkflow(client, { runId, signalName: "paid", schema: engine.schema }),
      ).rejects.toBeInstanceOf(RunNotOpenError);
      await expect(cancelWorkflow(client, { runId, schema: engine.schema })).rejects.toBeInstanceOf(
        RunAlreadyClosedError,
      );
      await client.query("insert into orders (id, total) values ('o-7', 70)");
    }, "commit");
    const orders = await app.pool.query("select 1 from orders where id = 'o-7'");
    expect(orders.rowCount).toBe(1);
  });

  it("creates the run timeout timer in the same transaction", async () => {
    const started = await inAppTransaction(
      (client) =>
        startWorkflow(client, {
          workflowType: "fulfil",
          schema: engine.schema,
          runTimeoutMs: 60_000,
        }),
      "commit",
    );
    const timers = await engine.pool.query<{ timer_id: string }>(
      "select timer_id from timers where run_id = $1",
      [started.runId],
    );
    expect(timers.rows).toEqual([{ timer_id: "run-timeout" }]);
  });
});
