import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultMigrationsDir,
  loadMigrations,
  migrateDown,
  migrateUp,
  pendingMigrations,
} from "./migrator.ts";
import {
  createIsolatedDatabase,
  createIsolatedSchema,
  type IsolatedSchema,
} from "./test-harness.ts";

describe("migrations into a named schema", () => {
  let app: IsolatedSchema;
  let engineSchema: string;

  beforeAll(async () => {
    app = await createIsolatedSchema();
    engineSchema = `${app.schema}_dee`;
  });

  afterAll(async () => {
    await app.pool.query(`drop schema if exists "${engineSchema}" cascade`);
    await app.close();
  });

  async function tablesIn(schema: string): Promise<string[]> {
    const result = await app.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = $1 order by table_name",
      [schema],
    );
    return result.rows.map((row) => row.table_name);
  }

  it("reports every migration pending for a schema that does not exist yet", async () => {
    const all = (await loadMigrations(defaultMigrationsDir)).map((migration) => migration.id);
    expect(
      await pendingMigrations(app.pool, defaultMigrationsDir, { schema: engineSchema }),
    ).toEqual(all);
  });

  it("creates the schema and puts the engine tables there, not next to the caller's", async () => {
    const applied = await migrateUp(app.pool, defaultMigrationsDir, { schema: engineSchema });
    expect(applied.length).toBeGreaterThan(20);
    expect(await tablesIn(engineSchema)).toContain("workflow_runs");
    expect(await tablesIn(engineSchema)).toContain("schema_migrations");
    expect(await tablesIn(app.schema)).toEqual([]);
    const functions = await app.pool.query<{ schema: string }>(
      `select n.nspname as schema from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.proname = 'start_workflow' and n.nspname = $1`,
      [engineSchema],
    );
    expect(functions.rowCount).toBe(1);
    expect(
      await pendingMigrations(app.pool, defaultMigrationsDir, { schema: engineSchema }),
    ).toEqual([]);
  });

  it("leaves the search_path of every pooled connection as it was", async () => {
    await migrateUp(app.pool, defaultMigrationsDir, { schema: engineSchema });
    const clients = await Promise.all([app.pool.connect(), app.pool.connect()]);
    try {
      for (const client of clients) {
        const path = await client.query<{ search_path: string }>(
          "select current_setting('search_path') as search_path",
        );
        expect(path.rows[0]?.search_path).toBe(app.schema);
      }
    } finally {
      for (const client of clients) {
        client.release();
      }
    }
  });

  it("reverts inside the named schema", async () => {
    await migrateUp(app.pool, defaultMigrationsDir, { schema: engineSchema });
    const reverted = await migrateDown(app.pool, defaultMigrationsDir, 1, { schema: engineSchema });
    expect(reverted).toEqual(["0022_event_version"]);
    expect(
      await pendingMigrations(app.pool, defaultMigrationsDir, { schema: engineSchema }),
    ).toEqual(["0022_event_version"]);
    await migrateUp(app.pool, defaultMigrationsDir, { schema: engineSchema });
  });

  it("rejects a schema name that is not a plain identifier", async () => {
    await expect(
      migrateUp(app.pool, defaultMigrationsDir, { schema: "a-b; drop schema public" }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("the integration suite's schema", () => {
  let database: IsolatedSchema;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  it("runs every test file against its own non-default schema", async () => {
    expect(database.schema).toMatch(/^test_[0-9a-f]{32}$/);
    const current = await database.pool.query<{ schema: string }>(
      "select current_schema() as schema",
    );
    expect(current.rows[0]?.schema).toBe(database.schema);
    const location = await database.pool.query<{ schema: string }>(
      "select table_schema as schema from information_schema.tables where table_name = 'workflow_runs' and table_schema = $1",
      [database.schema],
    );
    expect(location.rowCount).toBe(1);
  });
});
