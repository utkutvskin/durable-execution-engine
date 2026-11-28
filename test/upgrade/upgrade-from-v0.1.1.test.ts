import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHistoryExport,
  createInvariantChecker,
  createPostgresEventStore,
  defaultMigrationsDir,
  loadMigrations,
  migrateUp,
  pendingMigrations,
  replayHistories,
  type Pool,
} from "../../packages/core/src/index.ts";
import { createApiKeyStore, createRunService } from "../../packages/api/src/index.ts";
import { startEngine, type Engine } from "../../packages/worker/src/index.ts";
import {
  createIsolatedSchema,
  type IsolatedSchema,
} from "../../packages/core/src/db/test-harness.ts";
import { createUpgradeDefinitions } from "../fixtures/upgrade-v0.1.1/workflows.ts";

interface UpgradeFixture {
  readonly recordedWith: string;
  readonly migrations: readonly string[];
  readonly migrationChecksums: Readonly<Record<string, string>>;
  readonly apiKey: string;
  readonly namespaceId: string;
  readonly runs: {
    readonly completed: string;
    readonly waiting: string;
    readonly sleeping: string;
    readonly parent: string;
    readonly child: string;
    readonly retrying: string;
    readonly queued: string;
  };
  readonly stepCalls: Readonly<Record<string, number>>;
  readonly sequences: readonly { sequencename: string; last_value: string | null }[];
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
}

const FIXTURE_PATH = new URL("../fixtures/upgrade-v0.1.1/fixture.json", import.meta.url);

async function readFixture(): Promise<UpgradeFixture> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as UpgradeFixture;
}

async function copyMigrations(ids: readonly string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "dee-v0.1.1-migrations-"));
  for (const id of ids) {
    for (const suffix of [".up.sql", ".down.sql"]) {
      await copyFile(
        path.join(defaultMigrationsDir, `${id}${suffix}`),
        path.join(directory, `${id}${suffix}`),
      );
    }
  }
  return directory;
}

async function restoreRows(pool: Pool, fixture: UpgradeFixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    for (const [table, rows] of Object.entries(fixture.rows)) {
      if (table === "schema_migrations" || rows.length === 0) {
        continue;
      }
      await client.query(
        `insert into "${table}" select * from json_populate_recordset(null::"${table}", $1::json)`,
        [JSON.stringify(rows)],
      );
    }
    for (const sequence of fixture.sequences) {
      if (sequence.last_value !== null) {
        await client.query("select setval($1, $2::bigint)", [
          sequence.sequencename,
          sequence.last_value,
        ]);
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("upgrading a v0.1.1 database with open runs", () => {
  let fixture: UpgradeFixture;
  let database: IsolatedSchema;
  let pool: Pool;
  let oldMigrations: string;
  let engine: Engine | undefined;
  const calls = new Map<string, number>();
  const errors: unknown[] = [];

  beforeAll(async () => {
    fixture = await readFixture();
    database = await createIsolatedSchema();
    pool = database.pool;
    oldMigrations = await copyMigrations(fixture.migrations);
  });

  afterAll(async () => {
    await engine?.stop();
    await database.close();
    await rm(oldMigrations, { recursive: true, force: true });
  });

  async function statusOf(runId: string): Promise<{ status: string; result: unknown }> {
    const result = await pool.query<{ status: string; result: unknown }>(
      "select status, result from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0] ?? { status: "missing", result: null };
  }

  async function eventTypes(runId: string): Promise<string[]> {
    const result = await pool.query<{ event_type: string }>(
      "select event_type from run_events where run_id = $1 order by sequence_number",
      [runId],
    );
    return result.rows.map((row) => row.event_type);
  }

  it("ships the v0.1.1 migrations unchanged, so the fixture schema is the released one", async () => {
    expect(fixture.recordedWith).toBe("0.1.1");
    expect(fixture.migrations).toHaveLength(20);
    for (const [file, digest] of Object.entries(fixture.migrationChecksums)) {
      const content = await readFile(path.join(defaultMigrationsDir, file));
      expect(createHash("sha256").update(content).digest("hex"), file).toBe(digest);
    }
    expect(Object.keys(fixture.migrationChecksums)).toHaveLength(fixture.migrations.length * 2);
  });

  it("restores the v0.1.1 database and applies every migration since then", async () => {
    expect(await migrateUp(pool, oldMigrations)).toEqual(fixture.migrations);
    await restoreRows(pool, fixture);
    const all = await loadMigrations(defaultMigrationsDir);
    const newer = all
      .map((migration) => migration.id)
      .filter((id) => !fixture.migrations.includes(id));
    expect(await pendingMigrations(pool)).toEqual(newer);

    expect(await migrateUp(pool)).toEqual(newer);
    expect(await pendingMigrations(pool)).toEqual([]);
    const runs = await pool.query<{ count: string }>("select count(*) from workflow_runs");
    expect(Number(runs.rows[0]?.count)).toBe(Object.keys(fixture.runs).length);
    const events = await pool.query<{ count: string }>("select count(*) from run_events");
    expect(Number(events.rows[0]?.count)).toBe(fixture.rows["run_events"]?.length);
  }, 120_000);

  it("finds no invariant violation in the upgraded database before any worker runs", async () => {
    const report = await createInvariantChecker(pool, createPostgresEventStore(pool)).check();
    expect(report.violations).toEqual([]);
    expect(report.runsChecked).toBe(Object.keys(fixture.runs).length);
  });

  it("keeps the v0.1.1 api key working, as an admin key of its namespace", async () => {
    const key = await createApiKeyStore(pool).authenticate(fixture.apiKey);
    expect(key?.namespaceId).toBe(fixture.namespaceId);
    expect(key?.scope).toBe("admin");
  });

  it("finishes every open run with today's engine, without running finished steps again", async () => {
    const definitions = createUpgradeDefinitions({ flakyFails: false, calls });
    engine = startEngine({
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
    const service = createRunService(pool, { queueName: "default" });
    const { runs, namespaceId } = fixture;

    await service.signalRun(namespaceId, runs.waiting, "approve", { approver: "grace" });
    await service.signalRun(namespaceId, runs.child, "approve", { approver: "linus" });
    const open = [runs.waiting, runs.sleeping, runs.parent, runs.child, runs.retrying, runs.queued];
    await waitUntil(async () => {
      const statuses = await Promise.all(open.map(statusOf));
      return statuses.every((row) => row.status === "COMPLETED");
    }, "every open run of the v0.1.1 database to complete");

    expect((await statusOf(runs.waiting)).result).toEqual({
      reserved: "reserved waiting",
      captured: "captured waiting for grace",
    });
    expect((await statusOf(runs.sleeping)).result).toEqual({
      reserved: "reserved sleeping",
      captured: "captured sleeping for timer",
    });
    expect((await statusOf(runs.parent)).result).toEqual({
      reserved: "reserved parent",
      child: "captured parent-child for linus",
    });
    expect((await statusOf(runs.retrying)).result).toEqual({ booked: "booked retrying" });
    expect((await statusOf(runs.queued)).result).toEqual({ reserved: "reserved queued" });
    expect(Object.fromEntries(calls)).toEqual({
      "upgrade.reserve": 1,
      "upgrade.capture": 3,
      "upgrade.flaky": 1,
    });
    expect(await eventTypes(runs.sleeping)).toContain("timer_fired");
    expect(await eventTypes(runs.retrying)).toEqual([
      "run_started",
      "step_scheduled",
      "step_attempt_failed",
      "step_completed",
      "run_completed",
    ]);
    expect(errors).toEqual([]);
  }, 120_000);

  it("leaves a database the invariant checker accepts, whose histories replay against the code", async () => {
    await engine?.stop();
    engine = undefined;
    const store = createPostgresEventStore(pool);
    const report = await createInvariantChecker(pool, store).check();
    expect(report.violations).toEqual([]);
    expect((await statusOf(fixture.runs.completed)).status).toBe("COMPLETED");

    const { workflows } = createUpgradeDefinitions({ flakyFails: false, calls: new Map() });
    const histories = await Promise.all(
      Object.values(fixture.runs).map(async (runId) => ({
        source: runId,
        history: createHistoryExport({ runId, events: await store.read(runId) }),
      })),
    );
    const replayed = await replayHistories(workflows, histories);
    expect(replayed.results.filter((result) => !result.passed)).toEqual([]);
    expect(replayed.passed).toBe(Object.keys(fixture.runs).length);
  });
});
