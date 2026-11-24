import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCountingPool } from "../db/statement-counter.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { RUN_TIMEOUT_TIMER_ID } from "../timeouts/run-timeouts.ts";
import { createTimerScheduler } from "./timer-scheduler.ts";

const QUEUE = "batched";
const START = new Date("2026-05-01T08:00:00.000Z");

describe("batched timers", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let now = START;
  const clock = { now: () => now };

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
    await database.pool.query("delete from timers");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    now = START;
  });

  async function seedRuns(count: number, status = "RUNNING"): Promise<string[]> {
    const runs = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, status, queue_name)
       select $1, 'sleeper', $2, $3 from generate_series(1, $4)
       returning id`,
      [namespaceId, status, QUEUE, count],
    );
    return runs.rows.map((row) => row.id);
  }

  async function seedTimers(runIds: readonly string[], timerId: string, fireAt: Date) {
    await database.pool.query(
      `insert into timers (run_id, timer_id, fire_at)
       select run_id, $2, $3 from unnest($1::uuid[]) as seeded (run_id)`,
      [runIds, timerId, fireAt],
    );
  }

  async function count(sql: string): Promise<number> {
    const result = await database.pool.query<{ count: string }>(sql);
    return Number(result.rows[0]?.count);
  }

  it("fires 10,000 timers due at once exactly once across three racing schedulers", async () => {
    const runIds = await seedRuns(10_000);
    await seedTimers(runIds, "wake", new Date(START.getTime() + 1000));
    now = new Date(START.getTime() + 5000);
    const schedulers = [0, 1, 2].map(() =>
      createTimerScheduler(database.pool, { queueName: QUEUE, clock, batchSize: 250 }),
    );

    const reports = await Promise.all(schedulers.map((scheduler) => scheduler.catchUp()));

    const firedIds = reports.flatMap((report) => report.fired.map((timer) => timer.runId));
    expect(firedIds).toHaveLength(10_000);
    expect(new Set(firedIds).size).toBe(10_000);
    expect(await count("select count(*) from timers where state = 'FIRED'")).toBe(10_000);
    expect(
      await count(
        "select count(*) from (select run_id from run_events where event_type = 'timer_fired' group by run_id having count(*) = 1) once",
      ),
    ).toBe(10_000);
    expect(await count("select count(*) from tasks where task_type = 'WORKFLOW_TASK'")).toBe(
      10_000,
    );
    const again = await schedulers[0]?.catchUp();
    expect(again?.fired).toHaveLength(0);
  });

  it("fires a batch of 100 timers with a fixed number of statements", async () => {
    const runIds = await seedRuns(100);
    await seedTimers(runIds, "wake", START);
    const counting = createCountingPool(database.pool);
    const scheduler = createTimerScheduler(counting.pool, { queueName: QUEUE, clock });

    const report = await scheduler.tick();

    expect(report.fired).toHaveLength(100);
    expect(counting.statements.length).toBeLessThanOrEqual(8);
  });

  it("gives two timers of one run consecutive sequence numbers and one workflow task", async () => {
    const [runId = ""] = await seedRuns(1);
    await database.pool.query(
      `insert into run_events (run_id, sequence_number, event_type, payload, run_created_at)
       values ($1, 1, 'workflow_started', '{}'::jsonb, (select created_at from workflow_runs where id = $1))`,
      [runId],
    );
    await seedTimers([runId], "first", START);
    await seedTimers([runId], "second", new Date(START.getTime() + 1));
    now = new Date(START.getTime() + 10);

    const report = await createTimerScheduler(database.pool, { queueName: QUEUE, clock }).tick();

    expect(report.fired.map((timer) => timer.timerId)).toEqual(["first", "second"]);
    const events = await database.pool.query<{ sequence_number: string; timer_id: string }>(
      "select sequence_number, payload->>'timerId' as timer_id from run_events where run_id = $1 and event_type = 'timer_fired' order by sequence_number",
      [runId],
    );
    expect(events.rows.map((row) => [Number(row.sequence_number), row.timer_id])).toEqual([
      [2, "first"],
      [3, "second"],
    ]);
    const tasks = await database.pool.query<{ id: string; visible_at: Date }>(
      "select id, visible_at from tasks where run_id = $1",
      [runId],
    );
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0]?.visible_at).toEqual(START);
    expect(report.fired.every((timer) => timer.taskId === tasks.rows[0]?.id)).toBe(true);
  });

  it("closes the due timers of finished runs inside the same batch without events or tasks", async () => {
    const running = await seedRuns(3);
    const finished = await seedRuns(2, "COMPLETED");
    await seedTimers([...running, ...finished], "wake", START);

    const report = await createTimerScheduler(database.pool, { queueName: QUEUE, clock }).tick();

    expect(report.fired).toHaveLength(3);
    expect(report.cancelled).toBe(2);
    expect(await count("select count(*) from timers where state = 'CANCELLED'")).toBe(2);
    expect(await count("select count(*) from run_events")).toBe(3);
    expect(await count("select count(*) from tasks")).toBe(3);
  });

  it("ends a batch before a run timeout timer and fires that timer in its own transaction", async () => {
    const runIds = await seedRuns(3);
    await seedTimers(runIds.slice(0, 1), "wake", START);
    await seedTimers(runIds.slice(1, 2), RUN_TIMEOUT_TIMER_ID, new Date(START.getTime() + 1));
    await seedTimers(runIds.slice(2), "wake", new Date(START.getTime() + 2));
    now = new Date(START.getTime() + 10);
    const counting = createCountingPool(database.pool);
    const scheduler = createTimerScheduler(counting.pool, { queueName: QUEUE, clock });

    const report = await scheduler.tick();

    expect(report.fired.map((timer) => timer.timerId)).toEqual([
      "wake",
      RUN_TIMEOUT_TIMER_ID,
      "wake",
    ]);
    expect(counting.statements.filter((sql) => sql === "begin")).toHaveLength(4);
    const status = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runIds[1]],
    );
    expect(status.rows[0]?.status).toBe("TIMED_OUT");
  });
});
