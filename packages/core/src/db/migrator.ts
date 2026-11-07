import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { rollbackQuietly } from "./transaction.js";

/**
 * A single up/down migration pair, identified by the shared filename prefix
 * of its `.up.sql` and `.down.sql` files.
 */
export interface Migration {
  readonly id: string;
  readonly up: string;
  readonly down: string;
}

const UP_SUFFIX = ".up.sql";
const DOWN_SUFFIX = ".down.sql";

/**
 * The migrations shipped with `@dee/core`, resolved relative to this
 * module so it works identically from `src` (vitest) and from `dist`
 * (the compiled CLI).
 */
export const defaultMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * Reads every `<id>.up.sql` / `<id>.down.sql` pair from `migrationsDir` and
 * returns them ordered by `id`, ascending.
 */
export async function loadMigrations(migrationsDir: string): Promise<Migration[]> {
  const entries = await readdir(migrationsDir);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith(UP_SUFFIX)) {
      ids.add(entry.slice(0, -UP_SUFFIX.length));
    }
  }

  const sortedIds = [...ids].sort();
  return Promise.all(
    sortedIds.map(async (id) => {
      const [up, down] = await Promise.all([
        readFile(path.join(migrationsDir, `${id}${UP_SUFFIX}`), "utf8"),
        readFile(path.join(migrationsDir, `${id}${DOWN_SUFFIX}`), "utf8"),
      ]);
      return { id, up, down };
    }),
  );
}

const MIGRATION_LOCK_KEY = "dee:migrations";

async function acquireMigrationLock(client: PoolClient): Promise<void> {
  await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
}

async function releaseMigrationLock(client: PoolClient): Promise<boolean> {
  try {
    await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    return true;
  } catch {
    return false;
  }
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(
    `create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )`,
  );
}

async function getAppliedIds(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    "select id from schema_migrations order by id asc",
  );
  return result.rows.map((row) => row.id);
}

/**
 * Applies every migration in `migrationsDir` that is not yet recorded in
 * `schema_migrations`, in order, each inside its own transaction, while
 * holding a Postgres advisory lock so concurrent callers (several processes
 * starting together) run one after the other and the later ones find nothing
 * left to apply. Returns the ids applied. Calling this again with nothing pending is a no-op that
 * returns an empty array.
 */
export async function migrateUp(
  pool: Pool,
  migrationsDir: string = defaultMigrationsDir,
): Promise<string[]> {
  const migrations = await loadMigrations(migrationsDir);
  const client = await pool.connect();
  let broken = false;
  const applied: string[] = [];
  let locked = false;
  try {
    await acquireMigrationLock(client);
    locked = true;
    await ensureMigrationsTable(client);
    const alreadyApplied = new Set(await getAppliedIds(client));
    for (const migration of migrations) {
      if (alreadyApplied.has(migration.id)) {
        continue;
      }
      await client.query("begin");
      try {
        await client.query(migration.up);
        await client.query("insert into schema_migrations (id) values ($1)", [migration.id]);
        await client.query("commit");
      } catch (error) {
        broken = !(await rollbackQuietly(client));
        throw error;
      }
      applied.push(migration.id);
    }
  } finally {
    if (locked && !(await releaseMigrationLock(client))) {
      broken = true;
    }
    client.release(broken);
  }
  return applied;
}

/**
 * Reverts the most recently applied `steps` migrations, most recent first,
 * each inside its own transaction, under the same advisory lock as
 * `migrateUp`. Returns the ids reverted. Calling this
 * with fewer than `steps` migrations applied (including zero) reverts only
 * what is there and is a no-op when nothing is applied.
 */
export async function migrateDown(
  pool: Pool,
  migrationsDir: string = defaultMigrationsDir,
  steps = 1,
): Promise<string[]> {
  const migrations = await loadMigrations(migrationsDir);
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  const client = await pool.connect();
  let broken = false;
  const reverted: string[] = [];
  let locked = false;
  try {
    await acquireMigrationLock(client);
    locked = true;
    await ensureMigrationsTable(client);
    const appliedIds = await getAppliedIds(client);
    const toRevert = appliedIds.slice(-steps).reverse();
    for (const id of toRevert) {
      const migration = byId.get(id);
      if (!migration) {
        throw new Error(
          `cannot revert migration "${id}": its file is missing from ${migrationsDir}`,
        );
      }
      await client.query("begin");
      try {
        await client.query(migration.down);
        await client.query("delete from schema_migrations where id = $1", [id]);
        await client.query("commit");
      } catch (error) {
        broken = !(await rollbackQuietly(client));
        throw error;
      }
      reverted.push(id);
    }
  } finally {
    if (locked && !(await releaseMigrationLock(client))) {
      broken = true;
    }
    client.release(broken);
  }
  return reverted;
}

/**
 * The ids in `migrationsDir` that `schema_migrations` does not list yet,
 * oldest first. A database that was never migrated has all of them pending.
 * It takes no lock and changes nothing.
 */
export async function pendingMigrations(
  pool: Pool,
  migrationsDir: string = defaultMigrationsDir,
): Promise<string[]> {
  const migrations = await loadMigrations(migrationsDir);
  const exists = await pool.query<{ present: string | null }>(
    "select to_regclass('schema_migrations') as present",
  );
  if (exists.rows[0]?.present === null || exists.rows[0] === undefined) {
    return migrations.map((migration) => migration.id);
  }
  const applied = await pool.query<{ id: string }>("select id from schema_migrations");
  const done = new Set(applied.rows.map((row) => row.id));
  return migrations.filter((migration) => !done.has(migration.id)).map((migration) => migration.id);
}
