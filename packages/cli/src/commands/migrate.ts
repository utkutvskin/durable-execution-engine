import { createPool, defaultMigrationsDir, migrateDown, migrateUp } from "@dee/core";
import {
  databaseUrl,
  ensureDatabase,
  findComposeDirectory,
  isProduction,
  type DatabaseEffects,
} from "../database.ts";
import { CliError } from "../errors.ts";
import type { CliIo } from "../io.ts";
import { booleanFlag, parseCommand, stringFlag } from "./shared.ts";

/**
 * Hooks of the commands that reach for a database, so tests can replace
 * the probe and the compose start.
 */
export interface DatabaseHooks {
  readonly databaseEffects?: DatabaseEffects;
}

function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port === "" ? "" : `:${parsed.port}`}${parsed.pathname}`;
  } catch {
    return "the configured database";
  }
}

/**
 * `wf migrate [up|down] [--steps n] [--yes] [--database-url url]`: applies
 * pending migrations (`up`, the default) or reverts the last `n` (`down`,
 * default 1). Concurrent `up` runs are safe: they take turns under a
 * database lock. `down` destroys data, so it asks for confirmation on a
 * terminal; `--yes` answers for it, and without a terminal and without
 * `--yes` it refuses. Docker compose is never started when
 * `NODE_ENV=production`.
 */
export async function migrateCommand(
  args: readonly string[],
  io: CliIo,
  hooks: DatabaseHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    steps: { type: "string" },
    yes: { type: "boolean" },
    "database-url": { type: "string" },
  });
  const direction = parsed.positionals[0] ?? "up";
  if (direction !== "up" && direction !== "down") {
    throw new CliError(`unknown migrate direction "${direction}": use up or down`, 2);
  }
  const steps = Number(stringFlag(parsed, "steps") ?? "1");
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new CliError("--steps must be a positive integer", 2);
  }
  const url = databaseUrl(stringFlag(parsed, "database-url"), io.env);
  if (direction === "down" && !booleanFlag(parsed, "yes")) {
    if (io.confirm === undefined) {
      throw new CliError("migrate down needs confirmation: run it in a terminal or pass --yes", 2);
    }
    const confirmed = await io.confirm(
      `revert the last ${String(steps)} migration(s) on ${describeDatabase(url)}? this can delete data.`,
    );
    if (!confirmed) {
      io.stdout("aborted, nothing was reverted");
      return 1;
    }
  }
  const composeAllowed = !isProduction(io.env);
  await ensureDatabase({
    url,
    composeDirectory: composeAllowed ? findComposeDirectory(io.cwd) : undefined,
    composeAllowed,
    log: io.stderr,
    ...(hooks.databaseEffects === undefined ? {} : { effects: hooks.databaseEffects }),
  });
  const pool = createPool({ DATABASE_URL: url }, { max: 2 });
  try {
    const ids =
      direction === "up"
        ? await migrateUp(pool)
        : await migrateDown(pool, defaultMigrationsDir, steps);
    if (ids.length === 0) {
      io.stdout(
        direction === "up" ? "nothing to apply, the schema is current" : "nothing to revert",
      );
    }
    for (const id of ids) {
      io.stdout(`${direction === "up" ? "applied" : "reverted"} ${id}`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}
