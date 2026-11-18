import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import type { ClockSource } from "../workflow/sources.ts";
import {
  InvalidConcurrencyRuleError,
  readConcurrencyBacklog,
  readRunConcurrency,
  requeueWithConcurrency,
  resolveConcurrency,
  validateConcurrencyRule,
} from "./concurrency-keys.ts";
import { createTaskQueue, type LeasedTask, type TaskQueue, type TaskType } from "./task-queue.ts";

const QUEUE = "default";
const LEASE_MS = 30_000;

interface FakeClock extends ClockSource {
  advance(ms: number): void;
}

function createFakeClock(start: Date): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("concurrency keys", () => {
  let database: IsolatedSchema;
  let clock: FakeClock;
  let queue: TaskQueue;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    clock = createFakeClock(new Date("2026-01-01T00:00:00Z"));
    queue = createTaskQueue(database.pool, { clock });
    const created = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
  });

  async function createRun(key?: string, limit = 1): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, queue_name, concurrency_key,
         concurrency_limit)
       values ($1, 'keyed', $2, $3, $4) returning id`,
      [namespaceId, QUEUE, key ?? null, key === undefined ? null : limit],
    );
    return result.rows[0]?.id ?? "";
  }

  async function enqueue(
    runId: string,
    taskType: TaskType = "WORKFLOW_TASK",
    step?: { readonly key: string; readonly limit: number },
  ): Promise<string> {
    const id = await queue.enqueue({ namespaceId, runId, queueName: QUEUE, taskType });
    if (step !== undefined) {
      await database.pool.query(
        "update tasks set step_concurrency_key = $2, step_concurrency_limit = $3 where id = $1",
        [id, step.key, step.limit],
      );
    }
    return id;
  }

  async function dequeue(limit = 10): Promise<LeasedTask[]> {
    return queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: LEASE_MS, limit });
  }

  async function ackAll(tasks: readonly LeasedTask[]): Promise<void> {
    for (const task of tasks) {
      await queue.ack(task.id, task.leaseToken);
    }
  }

  it("leases one run per key at limit 1 and the next once the first has no open task", async () => {
    const first = await createRun("customer-1");
    const second = await createRun("customer-1");
    const other = await createRun("customer-2");
    await enqueue(first);
    await enqueue(second);
    await enqueue(other);

    const leased = await dequeue();

    expect(leased.map((task) => task.runId).sort()).toEqual([first, other].sort());
    expect(leased.find((task) => task.runId === first)?.concurrencyKey).toBe("customer-1");
    expect(await dequeue()).toEqual([]);
    await ackAll(leased);
    const next = await dequeue();
    expect(next.map((task) => task.runId)).toEqual([second]);
  });

  it("lets `limit` runs of a key hold a slot at once", async () => {
    const runs = [
      await createRun("tenant", 2),
      await createRun("tenant", 2),
      await createRun("tenant", 2),
    ];
    for (const runId of runs) {
      await enqueue(runId);
    }

    const leased = await dequeue();

    expect(leased).toHaveLength(2);
    const held = await database.pool.query<{ slot: number }>(
      "select slot from concurrency_slots where scope = 'run' order by slot",
    );
    expect(held.rows.map((row) => row.slot)).toEqual([0, 1]);
  });

  it("keeps the slot with a run while it has open tasks, so its step runs before a waiting run", async () => {
    const holder = await createRun("customer-1");
    const waiting = await createRun("customer-1");
    await enqueue(holder);
    const [decision] = await dequeue();
    await enqueue(waiting);
    await enqueue(holder, "STEP_TASK");
    if (decision === undefined) {
      throw new Error("no decision leased");
    }
    await queue.ack(decision.id, decision.leaseToken);

    const [step] = await dequeue();

    expect(step?.runId).toBe(holder);
    expect(step?.taskType).toBe("STEP_TASK");
    expect(await dequeue()).toEqual([]);
  });

  it("frees the slot of a run that sleeps and makes it wait for a slot when it wakes", async () => {
    const sleeper = await createRun("customer-1");
    const other = await createRun("customer-1");
    await enqueue(sleeper);
    await enqueue(other);
    const first = await dequeue();
    expect(first.map((task) => task.runId)).toEqual([sleeper]);

    await ackAll(first);
    const second = await dequeue();
    expect(second.map((task) => task.runId)).toEqual([other]);
    await enqueue(sleeper);
    expect(await dequeue()).toEqual([]);
    expect(await readRunConcurrency(database.pool, sleeper)).toEqual({
      key: "customer-1",
      limit: 1,
      holders: 1,
      holdsSlot: false,
      waitingForSlot: true,
    });

    await ackAll(second);
    expect((await dequeue()).map((task) => task.runId)).toEqual([sleeper]);
  });

  it("gives a crashed worker's run slot back with its lease, to the same run", async () => {
    const crashed = await createRun("customer-1");
    const waiting = await createRun("customer-1");
    await enqueue(crashed);
    await enqueue(waiting);
    const [lost] = await dequeue();
    expect(lost?.runId).toBe(crashed);

    clock.advance(LEASE_MS + 1);
    const reclaimed = await dequeue();

    expect(reclaimed.map((task) => task.id)).toEqual([lost?.id]);
    await ackAll(reclaimed);
    expect((await dequeue()).map((task) => task.runId)).toEqual([waiting]);
  });

  it("frees a step slot when its lease expires and when the step is nacked", async () => {
    const runId = await createRun();
    const step = { key: "payments-api", limit: 1 };
    const first = await enqueue(runId, "STEP_TASK", step);
    const second = await enqueue(runId, "STEP_TASK", step);
    const [crashed] = await dequeue();
    expect(crashed?.id).toBe(first);
    expect(crashed?.stepConcurrencyKey).toBe("payments-api");
    expect(await dequeue()).toEqual([]);

    clock.advance(LEASE_MS + 1);
    const [afterExpiry] = await dequeue(1);
    expect(afterExpiry?.id).toBe(second);
    if (afterExpiry === undefined) {
      throw new Error("no step leased after the lease expired");
    }
    await queue.nack(afterExpiry.id, afterExpiry.leaseToken, 60_000);
    const [afterNack] = await dequeue();
    expect(afterNack?.id).toBe(first);
    const live = await database.pool.query<{ task_id: string }>(
      "select task_id from concurrency_slots where scope = 'step'",
    );
    expect(live.rows).toEqual([{ task_id: first }]);
  });

  it("keeps a step slot alive while its lease is extended", async () => {
    const runId = await createRun();
    const step = { key: "payments-api", limit: 1 };
    await enqueue(runId, "STEP_TASK", step);
    const waiting = await enqueue(runId, "STEP_TASK", step);
    const [running] = await dequeue();
    if (running === undefined) {
      throw new Error("no step leased");
    }

    clock.advance(LEASE_MS - 1000);
    expect(await queue.extend(running.id, running.leaseToken, LEASE_MS)).toBe(true);
    clock.advance(2000);
    expect(await dequeue()).toEqual([]);
    await queue.ack(running.id, running.leaseToken);
    expect((await dequeue()).map((task) => task.id)).toEqual([waiting]);
  });

  it("does not let blocked keyed tasks hold back unkeyed work behind them", async () => {
    const holder = await createRun("hot");
    await enqueue(holder);
    await dequeue();
    for (let index = 0; index < 5; index += 1) {
      await enqueue(await createRun("hot"));
    }
    clock.advance(1000);
    const free = await createRun();
    await enqueue(free);

    const leased = await dequeue(1);

    expect(leased.map((task) => task.runId)).toEqual([free]);
  });

  it("never lets concurrent consumers lease two runs of one key", async () => {
    const keys = ["a", "b", "c"];
    for (let index = 0; index < 30; index += 1) {
      await enqueue(await createRun(keys[index % keys.length]));
    }

    const batches = await Promise.all(Array.from({ length: 8 }, () => dequeue(4)));

    const leased = batches.flat();
    const keysLeased = leased.map((task) => task.concurrencyKey);
    expect(new Set(keysLeased).size).toBe(keysLeased.length);
    expect(leased.length).toBe(3);
  });

  it("records every acquisition and release in the slot history", async () => {
    const first = await createRun("customer-1");
    const second = await createRun("customer-1");
    await enqueue(first);
    await enqueue(second);
    await ackAll(await dequeue());
    await ackAll(await dequeue());

    const history = await database.pool.query<{
      run_id: string;
      acquired_seq: string;
      released_seq: string | null;
    }>(
      `select run_id, acquired_seq, released_seq from concurrency_slot_history
       order by acquired_seq`,
    );
    expect(history.rows.map((row) => row.run_id)).toEqual([first, second]);
    const [a, b] = history.rows;
    expect(Number(a?.released_seq)).toBeLessThan(Number(b?.acquired_seq));
    expect(b?.released_seq).not.toBeNull();
  });

  it("records an evaluated key on the run and its open tasks and hands the task back", async () => {
    const runId = await createRun();
    await enqueue(runId);
    const [task] = await dequeue();
    if (task === undefined) {
      throw new Error("no task leased");
    }
    expect(task.concurrencyKey).toBeNull();

    const requeued = await requeueWithConcurrency(
      database.pool,
      {
        taskId: task.id,
        runId,
        leaseToken: task.leaseToken,
        run: { key: "customer-9", limit: 1 },
      },
      { clock },
    );

    expect(requeued).toBe(true);
    const [again] = await dequeue();
    expect(again?.id).toBe(task.id);
    expect(again?.concurrencyKey).toBe("customer-9");
    expect(
      await requeueWithConcurrency(database.pool, {
        taskId: task.id,
        runId,
        leaseToken: task.leaseToken,
        run: { key: "customer-9", limit: 1 },
      }),
    ).toBe(false);
    const later = await enqueue(runId);
    const stored = await database.pool.query<{ concurrency_key: string }>(
      "select concurrency_key from tasks where id = $1",
      [later],
    );
    expect(stored.rows[0]?.concurrency_key).toBe("customer-9");
  });

  it("reports held slots and queued tasks by key", async () => {
    for (let index = 0; index < 3; index += 1) {
      await enqueue(await createRun("customer-1"));
    }
    await enqueue(await createRun("customer-2"));
    await dequeue();

    const backlog = await readConcurrencyBacklog(database.pool, { clock });

    expect(backlog).toEqual([
      { scope: "run", namespace: "default", key: "customer-1", held: 1, queued: 2 },
      { scope: "run", namespace: "default", key: "customer-2", held: 1, queued: 0 },
    ]);
  });

  it("validates rules and evaluated keys", () => {
    expect(() => validateConcurrencyRule("workflow x", { key: () => "k", limit: 0 })).toThrow(
      InvalidConcurrencyRuleError,
    );
    expect(() => validateConcurrencyRule("workflow x", { key: () => "k", limit: 1.5 })).toThrow(
      /positive integer/,
    );
    const rule = validateConcurrencyRule("workflow x", {
      key: (input: { customer: string }) => input.customer,
      limit: 3,
    });
    expect(resolveConcurrency("workflow x", rule, { customer: "c-1" })).toEqual({
      key: "c-1",
      limit: 3,
    });
    expect(() => resolveConcurrency("workflow x", rule, { customer: "" })).toThrow(
      InvalidConcurrencyRuleError,
    );
    expect(() => resolveConcurrency("workflow x", rule, { customer: "k".repeat(257) })).toThrow(
      /1 to 256 characters/,
    );
  });
});
