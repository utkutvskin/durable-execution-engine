import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedSchema, type IsolatedSchema } from "./test-harness.ts";
import { createPool } from "./pool.ts";
import {
  loadMigrations,
  defaultMigrationsDir,
  migrateDown,
  migrateUp,
  pendingMigrations,
} from "./migrator.ts";

describe("migration advisory lock", () => {
  let database: IsolatedSchema;

  beforeEach(async () => {
    database = await createIsolatedSchema();
  });

  afterEach(async () => {
    await database.close();
  });

  it("lets four migrateUp calls started together all succeed", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => migrateUp(database.pool)));
    const expected = (await loadMigrations(defaultMigrationsDir)).map((entry) => entry.id);
    const appliedTotal = results.flat();
    expect([...appliedTotal].sort()).toEqual(expected);
    expect(results.filter((ids) => ids.length > 0)).toHaveLength(1);
    const rows = await database.pool.query("select id from schema_migrations");
    expect(rows.rowCount).toBe(expected.length);
  });

  it("waits for a held lock and applies once it is released", async () => {
    const holder = await database.pool.connect();
    await holder.query("select pg_advisory_lock(hashtext('dee:migrations'))");
    let finished = false;
    const pending = migrateUp(database.pool).then((ids) => {
      finished = true;
      return ids;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    await holder.query("select pg_advisory_unlock(hashtext('dee:migrations'))");
    holder.release();
    const applied = await pending;
    expect(applied.length).toBeGreaterThan(0);
  });

  it("leaves no advisory lock behind after migrateUp", async () => {
    const single = createPool({}, { schema: database.schema, max: 1 });
    try {
      await migrateUp(single);
      const stray = await single.query<{ held: boolean }>(
        "select pg_advisory_unlock(hashtext('dee:migrations')) as held",
      );
      expect(stray.rows[0]?.held).toBe(false);
    } finally {
      await single.end();
    }
  });

  it("releases the lock when migrateDown fails on a missing migration file", async () => {
    const single = createPool({}, { schema: database.schema, max: 1 });
    const empty = await mkdtemp(path.join(tmpdir(), "dee-empty-migrations-"));
    try {
      await migrateUp(single);
      await expect(migrateDown(single, empty)).rejects.toThrow(/its file is missing/);
      const stray = await single.query<{ held: boolean }>(
        "select pg_advisory_unlock(hashtext('dee:migrations')) as held",
      );
      expect(stray.rows[0]?.held).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
      await single.end();
    }
  });

  it("serializes migrateDown with a concurrent migrateUp", async () => {
    await migrateUp(database.pool);
    const total = (await loadMigrations(defaultMigrationsDir)).length;
    const [reverted] = await Promise.all([
      migrateDown(database.pool, defaultMigrationsDir, 1),
      migrateUp(database.pool),
    ]);
    expect(reverted).toHaveLength(1);
    const rows = await database.pool.query("select id from schema_migrations");
    expect([total - 1, total]).toContain(rows.rowCount);
  });

  it("lists every migration as pending before the first migrateUp", async () => {
    const total = (await loadMigrations(defaultMigrationsDir)).map((entry) => entry.id);
    expect(await pendingMigrations(database.pool)).toEqual(total);
  });

  it("lists nothing as pending after migrateUp and the reverted one after migrateDown", async () => {
    await migrateUp(database.pool);
    expect(await pendingMigrations(database.pool)).toEqual([]);
    const reverted = await migrateDown(database.pool, defaultMigrationsDir, 1);
    expect(await pendingMigrations(database.pool)).toEqual(reverted);
  });
});
