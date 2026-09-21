import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedSchema, type IsolatedSchema } from "./test-harness.js";
import { defaultMigrationsDir, loadMigrations, migrateDown, migrateUp } from "./migrator.js";

describe("loadMigrations", () => {
  it("pairs up.sql/down.sql files by id and orders them ascending", async () => {
    const migrations = await loadMigrations(defaultMigrationsDir);
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.id).toBe("0001_initial_schema");
    expect(migrations[0]?.up).toContain("create table namespaces");
    expect(migrations[0]?.down).toContain("drop table if exists namespaces");
    const ids = migrations.map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("migrateUp / migrateDown", () => {
  let database: IsolatedSchema;

  beforeEach(async () => {
    database = await createIsolatedSchema();
  });

  afterEach(async () => {
    await database.close();
  });

  it("applies every migration and records it in schema_migrations", async () => {
    const applied = await migrateUp(database.pool);
    expect(applied).toEqual(["0001_initial_schema"]);

    const result = await database.pool.query<{ id: string }>("select id from schema_migrations");
    expect(result.rows.map((row) => row.id)).toEqual(["0001_initial_schema"]);
  });

  it("is idempotent: running migrateUp again applies nothing", async () => {
    await migrateUp(database.pool);
    const secondRun = await migrateUp(database.pool);
    expect(secondRun).toEqual([]);
  });

  it("migrateDown reverts the most recently applied migration", async () => {
    await migrateUp(database.pool);
    const reverted = await migrateDown(database.pool);
    expect(reverted).toEqual(["0001_initial_schema"]);

    const result = await database.pool.query<{ id: string }>("select id from schema_migrations");
    expect(result.rows).toEqual([]);
  });

  it("is idempotent: migrateDown with nothing applied is a no-op", async () => {
    const reverted = await migrateDown(database.pool);
    expect(reverted).toEqual([]);
  });

  it("supports a full down-then-up cycle without leaving stray tables", async () => {
    await migrateUp(database.pool);
    await migrateDown(database.pool);
    await migrateUp(database.pool);

    const tables = await database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name != 'schema_migrations'
       order by table_name`,
      [database.schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "namespaces",
      "run_events",
      "step_results",
      "tasks",
      "timers",
      "workflow_runs",
    ]);
  });
});
