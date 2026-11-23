import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import type { ClockSource } from "../workflow/sources.ts";
import {
  clearNamespaceRetention,
  createRetentionSweeper,
  setNamespaceRetention,
  type RetentionSweeper,
} from "./retention-sweeper.ts";

const START = new Date("2026-07-01T00:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RETAINED_TABLES = [
  "workflow_task_results",
  "step_attempts",
  "timers",
  "schedule_triggers",
  "dead_letters",
  "all_tasks",
  "concurrency_slot_history",
] as const;

type TableCounts = Record<(typeof RETAINED_TABLES)[number], number>;

describe("retention for closed runs", () => {
  let database: IsolatedSchema;
  let now: Date;
  let triggerOffset = 0;
  const clock: ClockSource = { now: () => now };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    now = START;
    await database.pool.query("truncate namespaces cascade");
  });

  async function createNamespace(name: string): Promise<{ id: string; scheduleId: string }> {
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ($1) returning id",
      [name],
    );
    const id = namespace.rows[0]?.id ?? "";
    const schedule = await database.pool.query<{ id: string }>(
      `insert into schedules (namespace_id, name, cron_expression, workflow_type)
       values ($1, 'hourly', '0 * * * *', 'seed') returning id`,
      [id],
    );
    return { id, scheduleId: schedule.rows[0]?.id ?? "" };
  }

  async function seedRuns(
    namespace: { id: string; scheduleId: string },
    count: number,
    closedAt: Date | null,
  ): Promise<string[]> {
    const runs = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, status, closed_at)
       select $1, 'seed', case when $3::timestamptz is null then 'RUNNING' else 'COMPLETED' end, $3
       from generate_series(1, $2::int)
       returning id`,
      [namespace.id, count, closedAt],
    );
    const ids = runs.rows.map((row) => row.id);
    triggerOffset += 100_000;
    await database.pool.query(
      `with seeded as (
         select run_id, row_number() over () as n from unnest($1::uuid[]) as run_id
       ), results as (
         insert into workflow_task_results (run_id, task_key, first_sequence_number, last_sequence_number)
         select run_id, 'decision-1', 1, 2 from seeded
       ), attempts as (
         insert into step_attempts (run_id, step_id, attempt, error)
         select run_id, 'charge', 1, '{"message":"declined"}'::jsonb from seeded
       ), fired as (
         insert into timers (run_id, timer_id, fire_at, state, fired_at)
         select run_id, 'wait', $3, 'FIRED', $3 from seeded
       ), triggers as (
         insert into schedule_triggers (schedule_id, scheduled_for, outcome, run_id)
         select $2, $3::timestamptz - (n + $4::bigint) * interval '1 minute', 'STARTED', run_id
         from seeded
       ), letters as (
         insert into dead_letters
           (namespace_id, run_id, step_id, queue_name, attempts, error, reason, requeued_at)
         select $5, run_id, 'charge', 'default', 3, '{}'::jsonb, 'MAX_ATTEMPTS_EXHAUSTED', $3
         from seeded
       ), finished as (
         insert into tasks (namespace_id, run_id, queue_name, task_type, state, updated_at)
         select $5, run_id, 'default', 'STEP_TASK', 'COMPLETED', $3 from seeded
       ), slots as (
         insert into concurrency_slot_history
           (namespace_id, scope, concurrency_key, slot, slot_limit, run_id, acquired_seq, released_seq)
         select $5, 'run', 'tenant', 0, 1, run_id, n * 2, n * 2 + 1 from seeded
       )
       select 1`,
      [ids, namespace.scheduleId, closedAt ?? START, triggerOffset, namespace.id],
    );
    return ids;
  }

  async function countRows(runIds: string[] | null): Promise<TableCounts> {
    const counts: Partial<TableCounts> = {};
    for (const table of RETAINED_TABLES) {
      const result = await database.pool.query<{ count: string }>(
        `select count(*) from ${table} where $1::uuid[] is null or run_id = any($1::uuid[])`,
        [runIds],
      );
      counts[table] = Number(result.rows[0]?.count);
    }
    return counts as TableCounts;
  }

  async function fingerprint(runIds: string[]): Promise<string[]> {
    const fingerprints: string[] = [];
    for (const table of [...RETAINED_TABLES, "tasks", "workflow_runs"]) {
      const column = table === "workflow_runs" ? "id" : "run_id";
      const result = await database.pool.query<{ digest: string | null }>(
        `select md5(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text)) as digest
         from ${table} t where ${column} = any($1::uuid[])`,
        [runIds],
      );
      fingerprints.push(`${table}:${result.rows[0]?.digest ?? "empty"}`);
    }
    return fingerprints;
  }

  async function drain(sweeper: RetentionSweeper): Promise<number> {
    let purged = 0;
    for (;;) {
      const report = await sweeper.sweep();
      purged += report.runsPurged;
      if (report.runsPurged === 0 && report.tasksRetired === 0) {
        return purged;
      }
    }
  }

  it("brings every listed table back to the size of the open runs after 10,000 closed runs pass their retention", async () => {
    const namespace = await createNamespace("default");
    await seedRuns(namespace, 10_000, START);
    const open = await seedRuns(namespace, 25, null);
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type)
       select $1, run_id, 'default', 'WORKFLOW_TASK' from unnest($2::uuid[]) as run_id`,
      [namespace.id, open],
    );
    const openBefore = await countRows(open);
    expect((await countRows(null)).workflow_task_results).toBe(10_025);
    const sweeper = createRetentionSweeper(database.pool, {
      clock,
      closedRunRetentionMs: DAY_MS,
      batchSize: 2000,
    });

    now = new Date(START.getTime() + DAY_MS - 1);
    expect(await drain(sweeper)).toBe(0);
    expect((await countRows(null)).step_attempts).toBe(10_025);

    now = new Date(START.getTime() + DAY_MS);
    expect(await drain(sweeper)).toBe(10_000);

    expect(await countRows(null)).toEqual(openBefore);
    const tasks = await database.pool.query<{ state: string; count: string }>(
      "select state, count(*) from tasks group by state",
    );
    expect(tasks.rows).toEqual([{ state: "PENDING", count: "25" }]);
    const marked = await database.pool.query<{ count: string }>(
      "select count(*) from workflow_runs where purged_at is not null",
    );
    expect(marked.rows[0]?.count).toBe("10000");
  });

  it("leaves every row of an open run exactly as it was", async () => {
    const namespace = await createNamespace("default");
    await seedRuns(namespace, 200, START);
    const open = await seedRuns(namespace, 20, null);
    await database.pool.query("update tasks set state = 'PENDING' where run_id = any($1::uuid[])", [
      open,
    ]);
    const before = await fingerprint(open);
    now = new Date(START.getTime() + 30 * DAY_MS);

    const purged = await drain(
      createRetentionSweeper(database.pool, { clock, closedRunRetentionMs: 0, batchSize: 50 }),
    );

    expect(purged).toBe(200);
    expect(await fingerprint(open)).toEqual(before);
  });

  it("applies each namespace's own retention, and keeps a namespace set to keep forever", async () => {
    const short = await createNamespace("short");
    const standard = await createNamespace("standard");
    const forever = await createNamespace("forever");
    const shortRuns = await seedRuns(short, 10, START);
    const standardRuns = await seedRuns(standard, 10, START);
    const foreverRuns = await seedRuns(forever, 10, START);
    await setNamespaceRetention(database.pool, short.id, HOUR_MS);
    await setNamespaceRetention(database.pool, forever.id, null);
    const sweeper = createRetentionSweeper(database.pool, { clock, closedRunRetentionMs: DAY_MS });

    now = new Date(START.getTime() + 2 * HOUR_MS);
    const first = await sweeper.sweep();

    expect(first.namespaces.map((purge) => [purge.namespaceId, purge.runsPurged])).toEqual([
      [short.id, 10],
    ]);
    expect((await countRows(shortRuns)).step_attempts).toBe(0);
    expect((await countRows(standardRuns)).step_attempts).toBe(10);

    now = new Date(START.getTime() + 365 * DAY_MS);
    const second = await sweeper.sweep();

    expect(second.namespaces.map((purge) => purge.namespaceId)).toEqual([standard.id]);
    expect((await countRows(standardRuns)).timers).toBe(0);
    expect(await countRows(foreverRuns)).toEqual({
      workflow_task_results: 10,
      step_attempts: 10,
      timers: 10,
      schedule_triggers: 10,
      dead_letters: 10,
      all_tasks: 10,
      concurrency_slot_history: 10,
    });

    expect(await clearNamespaceRetention(database.pool, forever.id)).toBe(true);
    expect(await clearNamespaceRetention(database.pool, forever.id)).toBe(false);
    expect((await sweeper.sweep()).runsPurged).toBe(10);
  });

  it("purges only namespaces with their own retention when no default is given", async () => {
    const kept = await createNamespace("kept");
    const pruned = await createNamespace("pruned");
    await seedRuns(kept, 5, START);
    await seedRuns(pruned, 5, START);
    await setNamespaceRetention(database.pool, pruned.id, 0);
    now = new Date(START.getTime() + 365 * DAY_MS);

    const report = await createRetentionSweeper(database.pool, { clock }).sweep();

    expect(report.runsPurged).toBe(5);
    expect(report.namespaces.map((purge) => purge.namespaceId)).toEqual([pruned.id]);
    expect(report.rows).toEqual({
      workflowTaskResults: 5,
      stepAttempts: 5,
      timers: 5,
      scheduleTriggers: 5,
      deadLetters: 5,
      taskHistory: 5,
      concurrencySlotHistory: 5,
    });
  });

  it("purges each run once when three sweepers race", async () => {
    const namespace = await createNamespace("default");
    await seedRuns(namespace, 3000, START);
    now = new Date(START.getTime() + DAY_MS);
    const sweepers = Array.from({ length: 3 }, () =>
      createRetentionSweeper(database.pool, { clock, closedRunRetentionMs: 0, batchSize: 250 }),
    );

    const purged = await Promise.all(sweepers.map((sweeper) => drain(sweeper)));

    expect(purged.reduce((total, part) => total + part, 0)).toBe(3000);
    expect(await countRows(null)).toEqual({
      workflow_task_results: 0,
      step_attempts: 0,
      timers: 0,
      schedule_triggers: 0,
      dead_letters: 0,
      all_tasks: 0,
      concurrency_slot_history: 0,
    });
  });

  it("never deadlocks or leaves task history of a purged run when retirement races the purge", async () => {
    const namespace = await createNamespace("default");
    now = new Date(START.getTime() + DAY_MS);
    const sweeper = createRetentionSweeper(database.pool, {
      clock,
      closedRunRetentionMs: 0,
      finishedTaskGraceMs: 0,
      batchSize: 100,
    });
    for (let round = 0; round < 5; round += 1) {
      await seedRuns(namespace, 600, START);
      await Promise.all([
        sweeper.retireFinishedTasks(),
        sweeper.purgeClosedRuns(),
        sweeper.retireFinishedTasks(),
        sweeper.purgeClosedRuns(),
      ]);
      await drain(sweeper);
    }

    const leftover = await database.pool.query<{ count: string }>(
      `select count(*) from all_tasks t join workflow_runs r on r.id = t.run_id
       where r.purged_at is not null`,
    );
    expect(leftover.rows[0]?.count).toBe("0");
    const purged = await database.pool.query<{ count: string }>(
      "select count(*) from workflow_runs where purged_at is not null",
    );
    expect(purged.rows[0]?.count).toBe("3000");
  });

  it("keeps open dead letters, buffered triggers and the run rows, and drops old skipped triggers", async () => {
    const namespace = await createNamespace("default");
    const [runId] = await seedRuns(namespace, 1, START);
    await database.pool.query(
      `insert into dead_letters (namespace_id, run_id, step_id, queue_name, attempts, error, reason)
       values ($1, $2, 'refund', 'default', 3, '{}'::jsonb, 'MAX_ATTEMPTS_EXHAUSTED')`,
      [namespace.id, runId],
    );
    await database.pool.query(
      `insert into schedule_triggers (schedule_id, scheduled_for, outcome, created_at)
       values ($1, $2, 'SKIPPED', $2), ($1, $3, 'SKIPPED', $3), ($1, $4, 'BUFFERED', $2)`,
      [
        namespace.scheduleId,
        START,
        new Date(START.getTime() + 10 * DAY_MS),
        new Date(START.getTime() + HOUR_MS),
      ],
    );
    now = new Date(START.getTime() + 2 * DAY_MS);

    await createRetentionSweeper(database.pool, { clock, closedRunRetentionMs: DAY_MS }).sweep();

    const letters = await database.pool.query<{ step_id: string }>(
      "select step_id from dead_letters",
    );
    expect(letters.rows).toEqual([{ step_id: "refund" }]);
    const triggers = await database.pool.query<{ outcome: string }>(
      "select outcome from schedule_triggers order by scheduled_for",
    );
    expect(triggers.rows.map((row) => row.outcome)).toEqual(["BUFFERED", "SKIPPED"]);
    const run = await database.pool.query<{ status: string; purged: boolean }>(
      "select status, purged_at is not null as purged from workflow_runs where id = $1",
      [runId],
    );
    expect(run.rows).toEqual([{ status: "COMPLETED", purged: true }]);
  });

  it("rejects a negative retention, grace period or a batch size of zero", async () => {
    const namespace = await createNamespace("default");
    expect(() => createRetentionSweeper(database.pool, { closedRunRetentionMs: -1 })).toThrow(
      RangeError,
    );
    expect(() => createRetentionSweeper(database.pool, { finishedTaskGraceMs: -5 })).toThrow(
      RangeError,
    );
    expect(() => createRetentionSweeper(database.pool, { batchSize: 0 })).toThrow(RangeError);
    await expect(setNamespaceRetention(database.pool, namespace.id, 1.5)).rejects.toThrow(
      RangeError,
    );
  });
});
