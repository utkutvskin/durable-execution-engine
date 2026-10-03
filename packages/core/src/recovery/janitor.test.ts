import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createTaskQueue } from "../queue/task-queue.js";
import { createJanitor } from "./janitor.js";
import { createRecoveryMetrics } from "./metrics.js";

const START = new Date("2026-03-01T12:00:00.000Z");

function movableClock(): { now(): Date; advance(ms: number): void } {
  let elapsed = 0;
  return {
    now: () => new Date(START.getTime() + elapsed),
    advance(ms: number): void {
      elapsed += ms;
    },
  };
}

describe("janitor", () => {
  let database: IsolatedSchema;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from timers");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
  });

  async function createRun(createdAt: Date, status = "RUNNING"): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, status, created_at)
       values ($1, 'ship-order', $2, $3) returning id`,
      [namespaceId, status, createdAt],
    );
    return result.rows[0]?.id ?? "";
  }

  async function taskRow(
    taskId: string,
  ): Promise<{ state: string; leased_by: string | null; reclaim_count: number }> {
    const result = await database.pool.query<{
      state: string;
      leased_by: string | null;
      reclaim_count: number;
    }>("select state, leased_by, reclaim_count from tasks where id = $1", [taskId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("task row missing");
    }
    return row;
  }

  it("stamps the worker identity on a leased task and clears it on ack", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const runId = await createRun(START);
    const taskId = await queue.enqueue({
      namespaceId,
      runId,
      queueName: "q",
      taskType: "STEP_TASK",
    });

    const [leased] = await queue.dequeue({
      queueName: "q",
      visibilityTimeoutMs: 1000,
      workerId: "worker-a",
      workerVersion: "1.4.0",
    });
    const stamped = await database.pool.query<{ leased_by: string; leased_by_version: string }>(
      "select leased_by, leased_by_version from tasks where id = $1",
      [taskId],
    );
    expect(stamped.rows[0]).toEqual({ leased_by: "worker-a", leased_by_version: "1.4.0" });

    await queue.ack(taskId, leased?.leaseToken ?? "");
    expect((await taskRow(taskId)).leased_by).toBeNull();
  });

  it("reclaims a lease whose visibility timeout passed and reports who held it", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const janitor = createJanitor(database.pool, { clock });
    const runId = await createRun(START);
    const taskId = await queue.enqueue({
      namespaceId,
      runId,
      queueName: "q",
      taskType: "STEP_TASK",
    });
    await queue.dequeue({
      queueName: "q",
      visibilityTimeoutMs: 10_000,
      workerId: "worker-a",
      workerVersion: "1.4.0",
    });

    clock.advance(10_001);
    const reclaimed = await janitor.reclaimOrphanedLeases();

    expect(reclaimed).toEqual([
      {
        taskId,
        runId,
        queueName: "q",
        attempts: 1,
        leasedBy: "worker-a",
        leasedByVersion: "1.4.0",
      },
    ]);
    expect(await taskRow(taskId)).toEqual({ state: "PENDING", leased_by: null, reclaim_count: 1 });
  });

  it("leaves a lease that is still within its visibility timeout alone", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const janitor = createJanitor(database.pool, { clock });
    const runId = await createRun(START);
    const taskId = await queue.enqueue({
      namespaceId,
      runId,
      queueName: "q",
      taskType: "STEP_TASK",
    });
    await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 10_000 });

    clock.advance(9000);

    expect(await janitor.reclaimOrphanedLeases()).toEqual([]);
    expect((await taskRow(taskId)).state).toBe("LEASED");
  });

  it("makes a reclaimed task deliverable again with a new lease token and a bumped attempt count", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const janitor = createJanitor(database.pool, { clock });
    const runId = await createRun(START);
    await queue.enqueue({ namespaceId, runId, queueName: "q", taskType: "STEP_TASK" });
    const [first] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });

    clock.advance(1000);
    await janitor.reclaimOrphanedLeases();
    const [second] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });

    expect(second?.id).toBe(first?.id);
    expect(second?.attempts).toBe(2);
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    expect(await queue.ack(first?.id ?? "", first?.leaseToken ?? "")).toBe(false);
  });

  it("counts reclaims per worker in the recovery metrics", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const metrics = createRecoveryMetrics();
    const janitor = createJanitor(database.pool, { clock, metrics });
    const runId = await createRun(START);
    for (let index = 0; index < 3; index += 1) {
      await queue.enqueue({ namespaceId, runId, queueName: "q", taskType: "STEP_TASK" });
    }
    await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000, limit: 2, workerId: "a" });
    await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000, workerId: "b" });

    clock.advance(1000);
    await janitor.sweep();

    const snapshot = metrics.snapshot();
    expect(snapshot.leasesReclaimed).toBe(3);
    expect(snapshot.reclaimedByWorker).toEqual({ a: 2, b: 1 });
    expect(snapshot.sweeps).toBe(1);
    expect(snapshot.lastSweepAt).toEqual(clock.now());
  });

  it("detects a running run with no open task and no pending timer once the grace period passed", async () => {
    const clock = movableClock();
    const janitor = createJanitor(database.pool, { clock });
    const runId = await createRun(START);

    expect(await janitor.findStalledRuns({ graceMs: 60_000 })).toEqual([]);

    clock.advance(60_000);
    expect(await janitor.findStalledRuns({ graceMs: 60_000 })).toEqual([
      { runId, namespaceId, workflowType: "ship-order" },
    ]);
  });

  it("does not call a run stalled while it has an open task, a pending timer or is terminal", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const janitor = createJanitor(database.pool, { clock });
    const withTask = await createRun(START);
    await queue.enqueue({
      namespaceId,
      runId: withTask,
      queueName: "q",
      taskType: "WORKFLOW_TASK",
    });
    const withTimer = await createRun(START);
    await database.pool.query(
      "insert into timers (run_id, timer_id, fire_at) values ($1, 'timer-1', $2)",
      [withTimer, new Date(START.getTime() + 3_600_000)],
    );
    await createRun(START, "COMPLETED");

    clock.advance(120_000);

    expect(await janitor.findStalledRuns({ graceMs: 60_000 })).toEqual([]);
  });

  it("treats a run whose only task was acked as stalled", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const janitor = createJanitor(database.pool, { clock });
    const runId = await createRun(START);
    const taskId = await queue.enqueue({
      namespaceId,
      runId,
      queueName: "q",
      taskType: "STEP_TASK",
    });
    const [leased] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    await queue.ack(taskId, leased?.leaseToken ?? "");

    clock.advance(60_000);

    const stalled = await janitor.findStalledRuns({ graceMs: 30_000 });
    expect(stalled.map((run) => run.runId)).toEqual([runId]);
  });

  it("recovers a stalled run by enqueuing exactly one workflow task, even when two janitors race", async () => {
    const clock = movableClock();
    const first = createJanitor(database.pool, { clock });
    const second = createJanitor(database.pool, { clock });
    const runId = await createRun(START);
    clock.advance(60_000);
    const options = { graceMs: 30_000, queueName: "default/workflows" };

    const results = await Promise.all([
      first.recoverStalledRuns(options),
      second.recoverStalledRuns(options),
    ]);

    expect(results.flat().map((run) => run.runId)).toEqual([runId]);
    const tasks = await database.pool.query<{ task_type: string; queue_name: string }>(
      "select task_type, queue_name from tasks where run_id = $1",
      [runId],
    );
    expect(tasks.rows).toEqual([{ task_type: "WORKFLOW_TASK", queue_name: "default/workflows" }]);
    expect(await first.findStalledRuns({ graceMs: 30_000 })).toEqual([]);
  });

  it("sweeps leases and stalled runs together and records both in the metrics", async () => {
    const clock = movableClock();
    const queue = createTaskQueue(database.pool, { clock });
    const metrics = createRecoveryMetrics();
    const janitor = createJanitor(database.pool, { clock, metrics });
    const leasedRun = await createRun(START);
    await queue.enqueue({
      namespaceId,
      runId: leasedRun,
      queueName: "q",
      taskType: "STEP_TASK",
    });
    await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 1000 });
    const lostRun = await createRun(START);
    clock.advance(60_000);

    const report = await janitor.sweep({ graceMs: 30_000, queueName: "q" });

    expect(report.reclaimed).toHaveLength(1);
    expect(report.recovered.map((run) => run.runId)).toEqual([lostRun]);
    expect(metrics.snapshot()).toMatchObject({
      leasesReclaimed: 1,
      stalledRunsDetected: 1,
      stalledRunsRecovered: 1,
      sweeps: 1,
    });
  });

  it("rejects a negative grace period", async () => {
    const janitor = createJanitor(database.pool);
    await expect(janitor.findStalledRuns({ graceMs: -1 })).rejects.toThrow(RangeError);
  });
});
