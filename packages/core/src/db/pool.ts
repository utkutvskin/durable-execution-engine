import pg from "pg";
import type { Pool } from "pg";
import { resolveDatabaseUrl, type DatabaseUrlEnv } from "./env.ts";

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
 * error instead of waiting forever. `notifyWakeups` turns on
 * `dee.notify_wakeups` for every connection, so each transaction that
 * enqueues tasks sends one wake-up notification per queue (see
 * `EngineOptions.wakeups`).
 */
export interface CreatePoolOptions {
  readonly schema?: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly acquireTimeoutMillis?: number;
  readonly notifyWakeups?: boolean;
  readonly onError?: (error: Error) => void;
}

function sessionSettings(options: CreatePoolOptions): string | undefined {
  const settings = [
    ...(options.schema === undefined ? [] : [`-c search_path=${options.schema}`]),
    ...(options.notifyWakeups === true ? ["-c dee.notify_wakeups=on"] : []),
  ];
  return settings.length === 0 ? undefined : settings.join(" ");
}

/**
 * Creates a `pg` pool for the database `env` points at, so packages that
 * only talk to the queue and the event store need no direct `pg` dependency.
 */
export function createPool(env: DatabaseUrlEnv, options: CreatePoolOptions = {}): Pool {
  const settings = sessionSettings(options);
  const pool = new PoolConstructor({
    connectionString: resolveDatabaseUrl(env),
    ...(settings === undefined ? {} : { options: settings }),
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
