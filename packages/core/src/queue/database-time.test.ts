import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createJanitor } from "../recovery/janitor.js";
import { createTaskQueue } from "./task-queue.js";

const SKEW_MS = 30_000;

describe("database time", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, queue_name) values ($1, 'sample', 'q') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function hostClockOffsetBy(offsetMs: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + offsetMs));
  }

  async function leaseOne(): Promise<string> {
    const queue = createTaskQueue(database.pool);
    await queue.enqueue({ namespaceId, runId, queueName: "q", taskType: "STEP_TASK" });
    const [task] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 20_000 });
    return task?.id ?? "";
  }

  it("does not let a worker whose clock runs 30 seconds fast take a live lease", async () => {
    await leaseOne();
    hostClockOffsetBy(SKEW_MS);

    const taken = await createTaskQueue(database.pool).dequeue({
      queueName: "q",
      visibilityTimeoutMs: 20_000,
    });

    expect(taken).toEqual([]);
  });

  it("still lets an injected clock decide, which is how tests move time", async () => {
    await leaseOne();
    const fast = { now: () => new Date(Date.now() + SKEW_MS) };

    const taken = await createTaskQueue(database.pool, { clock: fast }).dequeue({
      queueName: "q",
      visibilityTimeoutMs: 20_000,
    });

    expect(taken).toHaveLength(1);
  });

  it("does not extend an expired lease for a worker whose clock runs 60 seconds slow", async () => {
    const queue = createTaskQueue(database.pool);
    await queue.enqueue({ namespaceId, runId, queueName: "q", taskType: "STEP_TASK" });
    const [task] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 20_000 });
    await database.pool.query(
      "update tasks set visible_at = now() - interval '1 second' where id = $1",
      [task?.id],
    );
    hostClockOffsetBy(-2 * SKEW_MS);

    const extended = await queue.extend(task?.id ?? "", task?.leaseToken ?? "", 20_000);

    expect(extended).toBe(false);
  });

  it("extends a live lease for a worker whose clock runs fast", async () => {
    const queue = createTaskQueue(database.pool);
    await queue.enqueue({ namespaceId, runId, queueName: "q", taskType: "STEP_TASK" });
    const [task] = await queue.dequeue({ queueName: "q", visibilityTimeoutMs: 20_000 });
    hostClockOffsetBy(SKEW_MS);

    const extended = await queue.extend(task?.id ?? "", task?.leaseToken ?? "", 20_000);

    expect(extended).toBe(true);
  });

  it("delays a task by the database's time, whatever the host clock says", async () => {
    hostClockOffsetBy(-SKEW_MS * 4);
    const queue = createTaskQueue(database.pool);
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: "q",
      taskType: "STEP_TASK",
      delayMs: 60_000,
    });

    const row = await database.pool.query<{ delay_ms: number }>(
      "select extract(epoch from (visible_at - now())) * 1000 as delay_ms from tasks",
    );

    expect(Number(row.rows[0]?.delay_ms)).toBeGreaterThan(55_000);
    expect(Number(row.rows[0]?.delay_ms)).toBeLessThanOrEqual(60_000);
  });

  it("does not let a janitor on a fast host reclaim a live lease", async () => {
    await leaseOne();
    hostClockOffsetBy(SKEW_MS);

    const reclaimed = await createJanitor(database.pool).reclaimOrphanedLeases();

    expect(reclaimed).toEqual([]);
  });

  it("does not let a janitor on a fast host call a fresh run stalled", async () => {
    await database.pool.query(
      "insert into run_events (run_id, sequence_number, event_type, payload) values ($1, 1, 'run_started', '{}'::jsonb)",
      [runId],
    );
    hostClockOffsetBy(SKEW_MS);

    const stalled = await createJanitor(database.pool).findStalledRuns({
      queueName: "q",
      graceMs: 10_000,
    });

    expect(stalled).toEqual([]);
  });
});
