import pg from "pg";
import type { Pool } from "pg";
import { resolveDatabaseUrl, type DatabaseUrlEnv } from "./env.js";

const { Pool: PoolConstructor } = pg;

/**
 * Options for `createPool`. `schema` makes every connection default to that
 * Postgres schema through `search_path`.
 */
export interface CreatePoolOptions {
  readonly schema?: string;
  readonly max?: number;
}

/**
 * Creates a `pg` pool for the database `env` points at, so packages that
 * only talk to the queue and the event store need no direct `pg` dependency.
 */
export function createPool(env: DatabaseUrlEnv, options: CreatePoolOptions = {}): Pool {
  return new PoolConstructor({
    connectionString: resolveDatabaseUrl(env),
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
    ...(options.max === undefined ? {} : { max: options.max }),
  });
}
