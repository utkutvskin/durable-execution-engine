import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../db/pool.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createJanitor } from "../recovery/janitor.ts";
import type { ClockSource } from "../workflow/sources.ts";
import { createTaskQueue, type TaskQueue } from "./task-queue.ts";

const START = new Date("2026-05-01T12:00:00.000Z");

describe("lease heartbeats", () => {
  let database: IsolatedSchema;
  let single: Pool;
  let namespaceId: string;
  let runId: string;
  let now: Date;
  const clock: ClockSource = { now: () => now };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    single = createPool(process.env, { schema: database.schema, max: 1 });
  });

  afterAll(async () => {
    await single.end();
    await database.close();
  });

  beforeEach(async () => {
    now = START;
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'beat') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
  });

  async function leaseSteps(queue: TaskQueue, count: number) {
    for (let index = 0; index < count; index += 1) {
      await queue.enqueue({ namespaceId, runId, queueName: "beats", taskType: "STEP_TASK" });
    }
    return queue.dequeue({ queueName: "beats", visibilityTimeoutMs: 10_000, limit: count });
  }

  async function hotUpdates(): Promise<{ updates: number; hot: number }> {
    await single.query("select pg_stat_force_next_flush()");
    await single.query("select 1");
    const stats = await database.pool.query<{ updates: string; hot: string }>(
      `select n_tup_upd as updates, n_tup_hot_upd as hot
       from pg_stat_user_tables where relid = 'tasks'::regclass`,
    );
    return { updates: Number(stats.rows[0]?.updates), hot: Number(stats.rows[0]?.hot) };
  }

  it("writes a heartbeat as a HOT update, which an update of visible_at is not", async () => {
    const queue = createTaskQueue(single, { clock });
    const leased = await leaseSteps(queue, 10);
    const before = await hotUpdates();

    const extended = await queue.extendMany?.(
      leased.map((task) => ({ taskId: task.id, leaseToken: task.leaseToken })),
      10_000,
    );
    const afterBeats = await hotUpdates();
    await single.query("update tasks set visible_at = visible_at + interval '1 second'");
    const afterIndexed = await hotUpdates();

    expect(extended).toEqual(leased.map(() => true));
    expect(afterBeats.updates - before.updates).toBe(10);
    expect(afterBeats.hot - before.hot).toBe(10);
    expect(afterIndexed.updates - afterBeats.updates).toBe(10);
    expect(afterIndexed.hot - afterBeats.hot).toBe(0);
  });

  it("keeps an extended lease from being taken again or reclaimed until the extension runs out", async () => {
    const queue = createTaskQueue(database.pool, { clock });
    const janitor = createJanitor(database.pool, { clock });
    const [task] = await leaseSteps(queue, 1);
    now = new Date(START.getTime() + 8_000);
    expect(await queue.extend(task?.id ?? "", task?.leaseToken ?? "", 10_000)).toBe(true);

    now = new Date(START.getTime() + 15_000);
    expect(await queue.dequeue({ queueName: "beats", visibilityTimeoutMs: 10_000 })).toEqual([]);
    expect(await janitor.reclaimOrphanedLeases()).toEqual([]);
    expect(await queue.extend(task?.id ?? "", task?.leaseToken ?? "", 10_000)).toBe(true);

    now = new Date(START.getTime() + 26_000);
    expect(await queue.extend(task?.id ?? "", task?.leaseToken ?? "", 10_000)).toBe(false);
    const [again] = await queue.dequeue({ queueName: "beats", visibilityTimeoutMs: 10_000 });
    expect(again?.id).toBe(task?.id);
    expect(again?.leaseToken).not.toBe(task?.leaseToken);
    expect(await queue.extend(again?.id ?? "", again?.leaseToken ?? "", 10_000)).toBe(true);
  });

  it("acks many leases in one call and reports a stale one as not acked", async () => {
    const queue = createTaskQueue(database.pool, { clock });
    const leased = await leaseSteps(queue, 4);
    const leases = leased.map((task) => ({ taskId: task.id, leaseToken: task.leaseToken }));
    const stale = {
      taskId: leased[0]?.id ?? "",
      leaseToken: "00000000-0000-4000-8000-000000000000",
    };

    const acked = await queue.ackMany?.([stale, ...leases]);

    expect(acked).toEqual([false, true, true, true, true]);
    const states = await database.pool.query<{ state: string }>(
      "select distinct state from tasks where run_id = $1",
      [runId],
    );
    expect(states.rows).toEqual([{ state: "COMPLETED" }]);
  });

  it("tunes autovacuum and leaves room for HOT updates on tasks, timers and run_stickiness", async () => {
    const options = await database.pool.query<{ relname: string; reloptions: string[] }>(
      `select relname, reloptions from pg_class
       where oid in ('tasks'::regclass, 'timers'::regclass, 'run_stickiness'::regclass)
       order by relname`,
    );
    const byTable = new Map(
      options.rows.map((row) => [
        row.relname,
        new Map(row.reloptions.map((entry) => entry.split("=") as [string, string])),
      ]),
    );
    for (const table of ["tasks", "timers", "run_stickiness"]) {
      const settings = byTable.get(table);
      expect(Number(settings?.get("fillfactor"))).toBeLessThan(100);
      expect(Number(settings?.get("autovacuum_vacuum_scale_factor"))).toBeLessThan(0.2);
      expect(Number(settings?.get("autovacuum_analyze_scale_factor"))).toBeLessThan(0.1);
    }
  });
});
