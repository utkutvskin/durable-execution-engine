import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPool,
  createSessionConnector,
  createTaskQueue,
  type Pool,
  type SessionConnection,
} from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { createMemoryQueue, createVirtualTime, waitFor } from "./test-support.ts";
import { WAKEUP_CHANNEL, startWakeupListener } from "./wakeup-listener.ts";
import { createWorker } from "./worker.ts";

describe("worker wake-ups", () => {
  it("polls at once on a wake instead of waiting out the backoff, and resets it", async () => {
    const queue = createMemoryQueue();
    const time = createVirtualTime();
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => Promise.resolve(),
      timers: time.timers,
      pollIntervalMs: 100,
      maxPollIntervalMs: 60_000,
    });
    worker.start();
    for (let poll = 1; poll <= 4; poll += 1) {
      await waitFor(() => queue.dequeueLimits.length === poll && time.pendingDelays().length > 0);
      time.advance(time.pendingDelays()[0] ?? 0);
    }
    await waitFor(() => time.pendingDelays()[0] === 1600);

    queue.add(1);
    worker.wake();

    await waitFor(() => queue.acked.length === 1);
    await waitFor(() => time.pendingDelays().includes(100));
    await worker.stop();
  });

  it("does not lose a wake that arrives while a poll is in flight", async () => {
    const queue = createMemoryQueue();
    const time = createVirtualTime();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dequeue = queue.dequeue.bind(queue);
    let polls = 0;
    const worker = createWorker({
      queue: {
        ...queue,
        dequeue: async (options) => {
          polls += 1;
          const leased = dequeue(options);
          if (polls === 1) {
            await held;
          }
          return leased;
        },
      },
      queueName: "q",
      handler: () => Promise.resolve(),
      timers: time.timers,
      pollIntervalMs: 60_000,
    });
    worker.start();
    await waitFor(() => polls === 1);

    queue.add(1);
    worker.wake();
    release();

    await waitFor(() => queue.acked.length === 1);
    expect(polls).toBeGreaterThanOrEqual(2);
    await worker.stop();
  });
});

describe("wake-up notifications from postgres", () => {
  let database: IsolatedSchema;
  let other: IsolatedSchema;
  let notifying: Pool;
  let namespaceId: string;
  let runId: string;
  let session: SessionConnection;
  const received: string[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    other = await createIsolatedDatabase();
    notifying = createPool(process.env, { schema: database.schema, notifyWakeups: true });
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, status, queue_name) values ($1, 'w', 'RUNNING', 'orders') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
    session = await createSessionConnector(database.pool)();
    session.onNotification((channel, payload) => {
      if (channel === WAKEUP_CHANNEL) {
        received.push(payload);
      }
    });
    await session.query(`listen ${WAKEUP_CHANNEL}`);
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await session.close();
    await notifying.end();
    await database.close();
    await other.close();
  });

  async function insertSteps(pool: Pool, queues: readonly string[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const queue of queues) {
        await client.query(
          "insert into tasks (namespace_id, run_id, queue_name, task_type, payload) values ($1, $2, $3, 'STEP_TASK', '{}'::jsonb)",
          [namespaceId, runId, queue],
        );
      }
      await client.query("commit");
    } finally {
      client.release();
    }
  }

  async function flushed(): Promise<void> {
    await notifying.query("select pg_notify($1, 'flush')", [WAKEUP_CHANNEL]);
    await waitFor(() => received.includes("flush"));
  }

  it("sends one notification per transaction and queue however many tasks it enqueues", async () => {
    await insertSteps(
      notifying,
      Array.from({ length: 30 }, () => "orders"),
    );
    await insertSteps(notifying, ["orders", "emails", "orders", "emails"]);
    await flushed();

    const wakeups = received.filter((payload) => payload !== "flush");
    expect(wakeups.map((payload) => JSON.parse(payload) as unknown)).toEqual([
      { schema: database.schema, queue: "orders" },
      { schema: database.schema, queue: "orders" },
      { schema: database.schema, queue: "emails" },
    ]);
  });

  it("sends nothing while dee.notify_wakeups is off for the enqueuing session", async () => {
    await insertSteps(database.pool, ["orders", "orders"]);
    await createTaskQueue(database.pool).enqueue({
      namespaceId,
      runId,
      queueName: "orders",
      taskType: "STEP_TASK",
      payload: {},
    });
    await flushed();

    expect(received).toEqual(["flush"]);
  });

  it("wakes the listener of the queue and schema only, and again after a reconnect", async () => {
    const wakes: string[] = [];
    const errors: unknown[] = [];
    const time = createVirtualTime();
    const pids: number[] = [];
    const connect = createSessionConnector(database.pool);
    const listener = startWakeupListener({
      connect: async () => {
        const opened = await connect();
        const rows = await opened.query<{ pid: number }>("select pg_backend_pid() as pid");
        pids.push(rows[0]?.pid ?? 0);
        return opened;
      },
      queueName: "orders",
      timers: time.timers,
      onWake: () => wakes.push("wake"),
      onError: (error) => errors.push(error),
    });
    await listener.ready;
    const otherSchema = createPool(process.env, { schema: other.schema, notifyWakeups: true });

    await insertSteps(notifying, ["emails"]);
    await otherSchema.query("select pg_notify($1, $2)", [
      WAKEUP_CHANNEL,
      JSON.stringify({ schema: other.schema, queue: "orders" }),
    ]);
    await insertSteps(notifying, ["orders"]);
    await waitFor(() => wakes.length === 1);
    await flushed();
    expect(wakes).toHaveLength(1);

    await database.pool.query("select pg_terminate_backend($1)", [pids[0]]);
    await waitFor(() => !listener.listening);
    time.advance(1000);
    await waitFor(() => listener.listening && wakes.length === 2);
    await insertSteps(notifying, ["orders"]);
    await waitFor(() => wakes.length === 3);

    expect(errors.length).toBeGreaterThan(0);
    await listener.stop();
    await otherSchema.end();
  });
});
