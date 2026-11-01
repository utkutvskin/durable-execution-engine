import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createJanitor } from "../recovery/janitor.js";
import { createTaskQueue, type TaskQueue } from "./task-queue.js";

const START = new Date("2026-02-01T00:00:00.000Z");

function movableClock(): { now(): Date; advance(ms: number): void } {
  let elapsed = 0;
  return {
    now: () => new Date(START.getTime() + elapsed),
    advance(ms: number): void {
      elapsed += ms;
    },
  };
}

describe("quarantine on dequeue", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;
  let clock: ReturnType<typeof movableClock>;
  let queue: TaskQueue;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from tasks");
    clock = movableClock();
    queue = createTaskQueue(database.pool, { clock, poisonThreshold: 3 });
  });

  function enqueue(): Promise<string> {
    return queue.enqueue({ namespaceId, runId, queueName: "q", taskType: "STEP_TASK" });
  }

  async function row(taskId: string): Promise<{
    state: string;
    reclaim_count: number;
    quarantine_reason: string | null;
  }> {
    const result = await database.pool.query<{
      state: string;
      reclaim_count: number;
      quarantine_reason: string | null;
    }>("select state, reclaim_count, quarantine_reason from tasks where id = $1", [taskId]);
    const found = result.rows[0];
    if (found === undefined) {
      throw new Error("task row missing");
    }
    return found;
  }

  async function loseLease(times = 1): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
      clock.advance(1001);
    }
  }

  it("counts a lease that expired as a reclaim when another consumer takes the task", async () => {
    const taskId = await enqueue();
    await loseLease();
    const [again] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    expect(again?.id).toBe(taskId);
    expect((await row(taskId)).reclaim_count).toBe(1);
  });

  it("does not count a first delivery or a nack as a reclaim", async () => {
    const taskId = await enqueue();
    const [first] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    await queue.nack(taskId, first?.leaseToken ?? "");
    await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    expect((await row(taskId)).reclaim_count).toBe(0);
  });

  it("quarantines a task that lost its lease at the threshold instead of delivering it", async () => {
    const taskId = await enqueue();
    await loseLease(3);
    const third = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    expect(third).toEqual([]);
    expect(await row(taskId)).toEqual({
      state: "QUARANTINED",
      reclaim_count: 3,
      quarantine_reason: "lease lost 3 times",
    });
    expect(await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 })).toEqual([]);
  });

  it("keeps delivering healthy tasks while a poison task is parked by a polling consumer", async () => {
    const poison = await enqueue();
    await loseLease(3);
    const healthy = await enqueue();
    const delivered = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000, limit: 5 });
    expect(delivered.map((task) => task.id)).toEqual([healthy]);
    expect((await row(poison)).state).toBe("QUARANTINED");
  });

  it("quarantines a task that keeps crashing workers while two other workers are polling", async () => {
    const poison = await enqueue();
    const workers = ["worker-a", "worker-b", "worker-c"];
    const received = new Map<string, number>();
    for (let round = 0; round < 6; round += 1) {
      for (const workerId of workers) {
        const taken = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000, workerId });
        taken.forEach((task) => {
          received.set(task.id, (received.get(task.id) ?? 0) + 1);
        });
      }
      clock.advance(1001);
    }
    expect(received.get(poison)).toBe(3);
    expect((await row(poison)).state).toBe("QUARANTINED");
  });

  it("shows a task parked by a polling consumer in the janitor quarantine list", async () => {
    const taskId = await enqueue();
    await loseLease(3);
    await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    const janitor = createJanitor(database.pool, { clock });
    const listed = await janitor.listQuarantined(namespaceId);
    expect(listed.map((task) => task.taskId)).toEqual([taskId]);
  });

  it("quarantines a leased task with the given reason and refuses a stale lease token", async () => {
    const taskId = await enqueue();
    const [leased] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    expect(await queue.quarantine(taskId, "00000000-0000-4000-8000-000000000000", "nope")).toBe(
      false,
    );
    expect(await queue.quarantine(taskId, leased?.leaseToken ?? "", "handler failed")).toBe(true);
    expect(await row(taskId)).toMatchObject({
      state: "QUARANTINED",
      quarantine_reason: "handler failed",
    });
    expect(await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 })).toEqual([]);
  });

  it("rejects a poison threshold that is not a positive integer", () => {
    expect(() => createTaskQueue(database.pool, { poisonThreshold: 0 })).toThrow(RangeError);
  });
});
