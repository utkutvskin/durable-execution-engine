/**
 * The subset of `process.env` that `resolveDatabaseUrl` reads from. Kept
 * narrow and structural so a plain object can be passed in tests without
 * mocking `process.env`.
 */
export interface DatabaseUrlEnv {
  readonly DATABASE_URL?: string | undefined;
  readonly POSTGRES_USER?: string | undefined;
  readonly POSTGRES_PASSWORD?: string | undefined;
  readonly POSTGRES_DB?: string | undefined;
  readonly POSTGRES_PORT?: string | undefined;
}

const DEFAULT_USER = "dee";
const DEFAULT_PASSWORD = "dee";
const DEFAULT_DB = "dee";
const DEFAULT_PORT = "5432";

/**
 * Resolves the Postgres connection string to use: `DATABASE_URL` if set,
 * otherwise built from the `POSTGRES_*` variables, falling back to the
 * same defaults as `docker-compose.yml` and `.env.example`.
 */
export function resolveDatabaseUrl(env: DatabaseUrlEnv): string {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  const user = env.POSTGRES_USER ?? DEFAULT_USER;
  const password = env.POSTGRES_PASSWORD ?? DEFAULT_PASSWORD;
  const db = env.POSTGRES_DB ?? DEFAULT_DB;
  const port = env.POSTGRES_PORT ?? DEFAULT_PORT;
  return `postgres://${user}:${password}@localhost:${port}/${db}`;
}
