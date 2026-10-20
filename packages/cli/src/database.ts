import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createPool, resolveDatabaseUrl } from "@dee/core";
import { CliError } from "./errors.js";

/**
 * The effects `ensureDatabase` needs, so tests can replace them.
 * `reachable` resolves true when the database answers a query,
 * `startCompose` brings up the `postgres` service of the compose file in
 * `directory` and resolves its exit code, and `pause` waits.
 */
export interface DatabaseEffects {
  readonly reachable: (url: string) => Promise<boolean>;
  readonly startCompose: (directory: string) => Promise<number>;
  readonly pause: (ms: number) => Promise<void>;
}

/**
 * What `ensureDatabase` needs: the connection `url`, the `composeDirectory`
 * that holds `docker-compose.yml` (when there is one), the number of
 * `attempts` to probe after starting compose (default 30) and the effects.
 */
export interface EnsureDatabaseInput {
  readonly url: string;
  readonly composeDirectory?: string | undefined;
  readonly attempts?: number;
  readonly log: (line: string) => void;
  readonly effects?: DatabaseEffects;
}

/**
 * The effects that talk to a real database and a real `docker compose`.
 */
export const systemDatabaseEffects: DatabaseEffects = {
  async reachable(url) {
    const pool = createPool({ DATABASE_URL: url }, { max: 1 });
    try {
      await pool.query("select 1");
      return true;
    } catch {
      return false;
    } finally {
      await pool.end().catch(() => undefined);
    }
  },
  startCompose(directory) {
    return new Promise((resolve) => {
      const child = spawn("docker", ["compose", "up", "-d", "--wait", "postgres"], {
        cwd: directory,
        stdio: "inherit",
      });
      child.on("error", () => {
        resolve(127);
      });
      child.on("close", (code) => {
        resolve(code ?? 1);
      });
    });
  },
  pause(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

/**
 * Finds the nearest directory at or above `start` that holds a
 * `docker-compose.yml`.
 */
export function findComposeDirectory(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, "docker-compose.yml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Makes sure the database at `url` answers. When it does not and a compose
 * file is at hand, starts the compose `postgres` service and waits for it.
 * Throws a `CliError` that says how to get a database when nothing works.
 */
export async function ensureDatabase(input: EnsureDatabaseInput): Promise<void> {
  const effects = input.effects ?? systemDatabaseEffects;
  if (await effects.reachable(input.url)) {
    return;
  }
  if (input.composeDirectory === undefined) {
    throw new CliError(
      "the database is not reachable and no docker-compose.yml was found: start postgres and set DATABASE_URL",
    );
  }
  input.log("database not reachable, starting postgres with docker compose");
  const code = await effects.startCompose(input.composeDirectory);
  if (code !== 0) {
    throw new CliError(
      "the database is not reachable and `docker compose up` failed: start postgres yourself and set DATABASE_URL",
    );
  }
  const attempts = input.attempts ?? 30;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await effects.reachable(input.url)) {
      return;
    }
    await effects.pause(1000);
  }
  throw new CliError("postgres was started but did not accept connections in time");
}

/**
 * The database url the cli uses: `--database-url`, else `DATABASE_URL`, else
 * the `POSTGRES_*` defaults.
 */
export function databaseUrl(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return flag ?? resolveDatabaseUrl(env);
}
