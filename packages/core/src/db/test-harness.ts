import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool } from "pg";
import { resolveDatabaseUrl } from "./env.js";
import { migrateUp } from "./migrator.js";

const { Pool: PoolConstructor } = pg;

/**
 * A Postgres schema created for a single test file (or a single test),
 * reachable through `pool`, whose connections default to that schema via
 * `search_path`. Call `close` when done to drop the schema and release the
 * pools.
 */
export interface IsolatedSchema {
  readonly schema: string;
  readonly pool: Pool;
  close(): Promise<void>;
}

function generateSchemaName(): string {
  return `test_${randomUUID().replaceAll("-", "")}`;
}

/**
 * Creates a fresh, empty Postgres schema and returns a pool scoped to it
 * via `search_path`. No migrations are applied; callers that need tables
 * run `migrateUp` themselves, or use `createIsolatedDatabase`.
 */
export async function createIsolatedSchema(): Promise<IsolatedSchema> {
  const connectionString = resolveDatabaseUrl(process.env);
  const schema = generateSchemaName();

  const adminPool = new PoolConstructor({ connectionString });
  await adminPool.query(`create schema "${schema}"`);

  const pool = new PoolConstructor({ connectionString, options: `-c search_path=${schema}` });

  return {
    schema,
    pool,
    async close(): Promise<void> {
      await pool.end();
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
      await adminPool.end();
    },
  };
}

/**
 * Creates a fresh, isolated Postgres schema with every migration applied.
 * Intended for one call per test file: two concurrently running test files
 * each get their own schema and cannot see each other's rows.
 */
export async function createIsolatedDatabase(): Promise<IsolatedSchema> {
  const isolatedSchema = await createIsolatedSchema();
  await migrateUp(isolatedSchema.pool);
  return isolatedSchema;
}
