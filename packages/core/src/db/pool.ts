import pg from "pg";
import type { Pool } from "pg";
import { resolveDatabaseUrl, type DatabaseUrlEnv } from "./env.js";

const { Pool: PoolConstructor } = pg;

/**
 * How long, in milliseconds, a pool waits for a free connection by default.
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Options for `createPool`. `schema` makes every connection default to that
 * Postgres schema through `search_path`. `idleTimeoutMillis` of 0 keeps idle
 * connections open and arms no timer when a client is released, which a
 * process needs when it also runs workflow decisions: those patch the global
 * `setTimeout` while they run. `acquireTimeoutMillis` is how long
 * `pool.connect()` may wait for a free connection before it fails; it
 * defaults to `DEFAULT_ACQUIRE_TIMEOUT_MS`, so an exhausted pool raises an
 * error instead of waiting forever.
 */
export interface CreatePoolOptions {
  readonly schema?: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly acquireTimeoutMillis?: number;
  readonly onError?: (error: Error) => void;
}

/**
 * Creates a `pg` pool for the database `env` points at, so packages that
 * only talk to the queue and the event store need no direct `pg` dependency.
 */
export function createPool(env: DatabaseUrlEnv, options: CreatePoolOptions = {}): Pool {
  const pool = new PoolConstructor({
    connectionString: resolveDatabaseUrl(env),
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
    connectionTimeoutMillis: options.acquireTimeoutMillis ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.idleTimeoutMillis === undefined
      ? {}
      : { idleTimeoutMillis: options.idleTimeoutMillis }),
  });
  const report = options.onError ?? ((): void => undefined);
  pool.on("error", report);
  pool.on("connect", (client) => {
    client.on("error", report);
  });
  return pool;
}
