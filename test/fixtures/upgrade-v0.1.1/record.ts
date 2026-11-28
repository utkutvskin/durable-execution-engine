import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPool,
  defaultMigrationsDir,
  migrateUp,
  type Pool,
} from "../../../packages/core/src/index.ts";
import { createApiKeyStore, createRunService } from "../../../packages/api/src/index.ts";
import { startEngine } from "../../../packages/worker/src/index.ts";
import { createUpgradeDefinitions, UPGRADE_WORKFLOW_TYPES } from "./workflows.ts";

const SCHEMA = "upgrade_fixture_record";
const FIXTURE_KEY = "dee_upgradefixture0000000000000000";

async function waitFor(pool: Pool, what: string, sql: string, params: unknown[]): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    const result = await pool.query<{ ok: boolean }>(sql, params);
    if (result.rows[0]?.ok === true) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const events = await pool.query<{ event_type: string }>(
    "select event_type from run_events where run_id = $1 order by sequence_number",
    [params[0]],
  );
  const tasks = await pool.query<{ task_type: string; state: string }>(
    "select task_type, state from tasks where run_id = $1",
    [params[0]],
  );
  throw new Error(
    `timed out waiting for ${what}: events ${JSON.stringify(events.rows)}, tasks ${JSON.stringify(tasks.rows)}`,
  );
}

async function hasEvent(pool: Pool, runId: string, eventType: string): Promise<void> {
  await waitFor(
    pool,
    `${eventType} on ${runId}`,
    "select exists (select 1 from run_events where run_id = $1 and event_type = $2) as ok",
    [runId, eventType],
  );
}

async function migrationChecksums(): Promise<Record<string, string>> {
  const files = (await readdir(defaultMigrationsDir)).filter((file) => file.endsWith(".sql"));
  const sums: Record<string, string> = {};
  for (const file of files.sort()) {
    const content = await readFile(path.join(defaultMigrationsDir, file));
    sums[file] = createHash("sha256").update(content).digest("hex");
  }
  return sums;
}

describe("recording the v0.1.1 upgrade fixture", () => {
  it("leaves open runs behind and dumps every table", async () => {
    const out = process.env["UPGRADE_FIXTURE_OUT"];
    if (out === undefined) {
      throw new Error("set UPGRADE_FIXTURE_OUT to the path of the fixture to write");
    }
    const admin = createPool(process.env);
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    const pool = createPool(process.env, { schema: SCHEMA });
    const applied = await migrateUp(pool);

    const keys = createApiKeyStore(pool);
    await keys.ensureNamespace("default");
    const adopted = await keys.adopt("default", FIXTURE_KEY);
    const namespaceId = adopted.namespaceId;
    const service = createRunService(pool, { queueName: "default" });
    const calls = new Map<string, number>();
    const errors: unknown[] = [];
    const definitions = createUpgradeDefinitions({ flakyFails: true, calls });
    const engine = startEngine({
      pool,
      ...definitions,
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      concurrency: 4,
      shutdownTimeoutMs: 2_000,
      onError: (error) => {
        errors.push(error);
      },
    });

    const start = async (workflowType: string, order: string): Promise<string> => {
      const started = await service.startRun(namespaceId, { workflowType, input: { order } });
      return started.run.runId;
    };
    const completed = await start(UPGRADE_WORKFLOW_TYPES.approval, "completed");
    const waiting = await start(UPGRADE_WORKFLOW_TYPES.approval, "waiting");
    const sleeping = await start(UPGRADE_WORKFLOW_TYPES.sleeper, "sleeping");
    const parent = await start(UPGRADE_WORKFLOW_TYPES.parent, "parent");
    const retrying = await start(UPGRADE_WORKFLOW_TYPES.retrying, "retrying");

    const waitingOn = `select exists (
         select 1 from run_events where run_id = $1 and event_type = 'step_completed'
       ) and not exists (
         select 1 from tasks where run_id = $1 and state in ('PENDING', 'LEASED')
       ) as ok`;
    await waitFor(pool, "the completed run to wait", waitingOn, [completed]);
    await service.signalRun(namespaceId, completed, "approve", { approver: "ada" });
    await hasEvent(pool, completed, "run_completed");
    await waitFor(pool, "the waiting run to wait", waitingOn, [waiting]);
    await hasEvent(pool, sleeping, "timer_started");
    await hasEvent(pool, parent, "child_started");
    const child = await pool.query<{ id: string }>(
      "select id from workflow_runs where parent_run_id = $1",
      [parent],
    );
    const childId = child.rows[0]?.id ?? "";
    await waitFor(pool, "the child to wait", waitingOn, [childId]);
    await hasEvent(pool, retrying, "step_attempt_failed");
    await engine.stop();

    const queued = await start(UPGRADE_WORKFLOW_TYPES.queued, "queued");

    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = current_schema() and table_type = 'BASE TABLE'
       order by table_name`,
    );
    const rows: Record<string, unknown[]> = {};
    for (const { table_name: table } of tables.rows) {
      const dumped = await pool.query<{ rows: unknown[] }>(
        `select coalesce(json_agg(t), '[]'::json) as rows from "${table}" t`,
      );
      rows[table] = dumped.rows[0]?.rows ?? [];
    }
    const sequences = await pool.query<{ sequencename: string; last_value: string | null }>(
      `select sequencename, last_value from pg_sequences
       where schemaname = current_schema() order by sequencename`,
    );

    const fixture = {
      recordedWith: "0.1.1",
      recordedAt: new Date().toISOString(),
      migrations: applied,
      migrationChecksums: await migrationChecksums(),
      apiKey: FIXTURE_KEY,
      namespaceId,
      runs: { completed, waiting, sleeping, parent, child: childId, retrying, queued },
      stepCalls: Object.fromEntries(calls),
      sequences: sequences.rows,
      rows,
    };
    await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
    expect(applied.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    await pool.end();
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.end();
  }, 120_000);
});
