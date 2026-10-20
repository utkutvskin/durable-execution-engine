import { createPool, defaultMigrationsDir, migrateDown, migrateUp } from "@dee/core";
import {
  databaseUrl,
  ensureDatabase,
  findComposeDirectory,
  type DatabaseEffects,
} from "../database.js";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import { parseCommand, stringFlag } from "./shared.js";

/**
 * Hooks of the commands that reach for a database, so tests can replace
 * the probe and the compose start.
 */
export interface DatabaseHooks {
  readonly databaseEffects?: DatabaseEffects;
}

/**
 * `wf migrate [up|down] [--steps n] [--database-url url]`: applies pending
 * migrations (`up`, the default) or reverts the last `n` (`down`, default 1).
 */
export async function migrateCommand(
  args: readonly string[],
  io: CliIo,
  hooks: DatabaseHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    steps: { type: "string" },
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
  await ensureDatabase({
    url,
    composeDirectory: findComposeDirectory(io.cwd),
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
