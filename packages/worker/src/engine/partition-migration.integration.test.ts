import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInvariantChecker,
  createPostgresEventStore,
  defineStep,
  defineWorkflow,
  migrateDown,
  migrateUp,
  type Pool,
} from "@dee/core";
import { createRunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { startEngine } from "./runtime.ts";

const CLOSED_RUNS = 99_800;
const OPEN_PLAIN_RUNS = 100;
const OPEN_HELD_RUNS = 100;

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 6000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("converting run_events to a partitioned table", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let namespaceId: string;

  const bump = defineStep<{ index: number }, number>("bump", {
    handler: ({ index }) => index + 1,
  });
  const plain = defineWorkflow("plain", async (ctx, input: { index: number }) => {
    return ctx.step<number>("bump", input);
  });
  const held = defineWorkflow("held", async (ctx, input: { index: number }) => {
    const bumped = await ctx.step<number>("bump", input);
    const go = await ctx.waitForSignal<{ bonus: number }>("go");
    return bumped + go.bonus;
  });

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
    expect(await migrateDown(pool, undefined, 3)).toEqual([
      "0039_reset_and_batches",
      "0038_key_scopes_and_audit_log",
      "0037_partitioned_run_events",
    ]);
    const namespace = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  async function seedClosedRuns(): Promise<void> {
    await pool.query(
      `with runs as (
         insert into workflow_runs (namespace_id, workflow_type, status, input, result,
                                    created_at, started_at, closed_at, last_sequence_number)
         select $1, 'plain', 'COMPLETED', jsonb_build_object('index', i), to_jsonb(i + 1),
                now() - (i % 60) * interval '1 day', now() - (i % 60) * interval '1 day',
                now() - (i % 60) * interval '1 day' + interval '1 second', 2
         from generate_series(1, $2::int) as i
         returning id, input, result
       )
       insert into run_events (run_id, sequence_number, event_type, payload)
       select id, 1, 'run_started',
              jsonb_build_object('type', 'run_started', 'workflowType', 'plain', 'input', input)
       from runs
       union all
       select id, 2, 'run_completed', jsonb_build_object('type', 'run_completed', 'result', result)
       from runs`,
      [namespaceId, CLOSED_RUNS],
    );
  }

  async function seedOpenRuns(workflowType: string, count: number): Promise<string[]> {
    const result = await pool.query<{ id: string }>(
      `with runs as (
         insert into workflow_runs (namespace_id, workflow_type, input, created_at, started_at)
         select $1, $2, jsonb_build_object('index', i), now() - interval '3 days',
                now() - interval '3 days'
         from generate_series(1, $3::int) as i
         returning id, namespace_id, input
       ),
       events as (
         insert into run_events (run_id, sequence_number, event_type, payload)
         select id, 1, 'run_started',
                jsonb_build_object('type', 'run_started', 'workflowType', $2::text, 'input', input)
         from runs
       )
       insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
       select namespace_id, id, 'default', 'WORKFLOW_TASK', '{"reason":"start"}'::jsonb
       from runs
       returning run_id as id`,
      [namespaceId, workflowType, count],
    );
    return result.rows.map((row) => row.id);
  }

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count);
  }

  it("converts 100,000 runs, open and closed, and every open run completes afterwards", async () => {
    await seedClosedRuns();
    const plainRuns = await seedOpenRuns("plain", OPEN_PLAIN_RUNS);
    const heldRuns = await seedOpenRuns("held", OPEN_HELD_RUNS);
    const open = [...plainRuns, ...heldRuns];
    expect(await count("select count(*) from workflow_runs")).toBe(100_000);
    const eventsBefore = await count("select count(*) from run_events");
    const fingerprintBefore = await pool.query<{ digest: string }>(
      `select md5(string_agg(run_id::text || sequence_number || event_type || payload::text, ','
                             order by run_id, sequence_number)) as digest
       from run_events`,
    );

    expect(await migrateUp(pool)).toEqual([
      "0037_partitioned_run_events",
      "0038_key_scopes_and_audit_log",
      "0039_reset_and_batches",
    ]);

    expect(await count("select count(*) from run_events")).toBe(eventsBefore);
    expect(await count("select count(*) from run_events_legacy")).toBe(eventsBefore);
    const fingerprintAfter = await pool.query<{ digest: string }>(
      `select md5(string_agg(run_id::text || sequence_number || event_type || payload::text, ','
                             order by run_id, sequence_number)) as digest
       from run_events`,
    );
    expect(fingerprintAfter.rows[0]?.digest).toBe(fingerprintBefore.rows[0]?.digest);
    expect(
      await count(
        `select count(*) from run_events event join workflow_runs run on run.id = event.run_id
         where event.run_created_at <> run.created_at`,
      ),
    ).toBe(0);
    const partitioned = await pool.query<{ kind: string }>(
      "select relkind::text as kind from pg_class where oid = 'run_events'::regclass",
    );
    expect(partitioned.rows[0]?.kind).toBe("p");

    const errors: unknown[] = [];
    const engine = startEngine({
      pool,
      workflows: [plain, held],
      steps: [bump],
      pollIntervalMs: 5,
      loopIntervalMs: 50,
      stickyRouting: false,
      shutdownTimeoutMs: 2_000,
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      const service = createRunService(pool, { queueName: "default" });
      await waitUntil(
        async () =>
          (await count(
            "select count(*) from workflow_runs where id = any($1::uuid[]) and waiting_on is not null",
            [heldRuns],
          )) === OPEN_HELD_RUNS,
        "the held runs to wait for their signal",
      );
      for (const runId of heldRuns) {
        await service.signalRun(namespaceId, runId, "go", { bonus: 1000 });
      }
      await waitUntil(
        async () =>
          (await count(
            "select count(*) from workflow_runs where id = any($1::uuid[]) and status = 'COMPLETED'",
            [open],
          )) === open.length,
        "every open run to complete",
      );
    } finally {
      await engine.stop();
    }

    const results = await pool.query<{ result: number }>(
      "select result from workflow_runs where id = any($1::uuid[]) order by result",
      [heldRuns],
    );
    expect(results.rows.map((row) => row.result)).toEqual(
      Array.from({ length: OPEN_HELD_RUNS }, (_, index) => index + 1002),
    );
    expect(
      await count(
        "select count(*) from run_events_legacy where run_id = any($1::uuid[]) and sequence_number > 1",
        [open],
      ),
    ).toBeGreaterThan(open.length * 3);
    const report = await createInvariantChecker(pool, createPostgresEventStore(pool)).check({
      runIds: open,
    });
    expect(report.violations).toEqual([]);
    expect(errors).toEqual([]);
  }, 300_000);
});
