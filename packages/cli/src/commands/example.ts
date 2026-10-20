import { createPool } from "@dee/core";
import { databaseUrl, ensureDatabase, findComposeDirectory } from "../database.js";
import { startDevEnvironment } from "../dev-environment.js";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import { EXAMPLE_NAMES, loadExampleDemo, type ExampleName } from "../modules.js";
import type { DatabaseHooks } from "./migrate.js";
import { parseCommand, requirePositional, stringFlag } from "./shared.js";

/**
 * `wf example <payment-saga|etl-pipeline|all>`: runs a bundled example end to
 * end. It starts the api and a worker for the example in this process, plays
 * the example's scenarios through the api and prints what happened. The exit
 * code is 0 when every scenario ended as expected.
 */
export async function exampleCommand(
  args: readonly string[],
  io: CliIo,
  hooks: DatabaseHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, { "database-url": { type: "string" } });
  const target = requirePositional(parsed, 0, `example name (${EXAMPLE_NAMES.join(", ")} or all)`);
  const names: readonly ExampleName[] =
    target === "all" ? EXAMPLE_NAMES : EXAMPLE_NAMES.filter((name) => name === target);
  if (names.length === 0) {
    throw new CliError(`unknown example "${target}": use ${EXAMPLE_NAMES.join(", ")} or all`, 2);
  }
  const url = databaseUrl(stringFlag(parsed, "database-url"), io.env);
  await ensureDatabase({
    url,
    composeDirectory: findComposeDirectory(io.cwd),
    log: io.stderr,
    ...(hooks.databaseEffects === undefined ? {} : { effects: hooks.databaseEffects }),
  });
  const pool = createPool({ DATABASE_URL: url });
  let failed = false;
  try {
    for (const name of names) {
      const demo = await loadExampleDemo(name);
      io.stdout(`== ${name}: ${demo.description}`);
      const environment = await startDevEnvironment({
        pool,
        module: demo.module,
        port: 0,
        namespace: `example-${name}-${String(Date.now())}`,
        loopIntervalMs: 200,
        pollIntervalMs: 20,
        onError: (error) => {
          io.stderr(`engine error: ${error instanceof Error ? error.message : String(error)}`);
        },
      });
      try {
        const report = await demo.run({
          client: environment.client,
          schedules: environment.schedules,
          namespaceId: environment.namespaceId,
          log: io.stdout,
        });
        io.stdout(
          report.ok ? `ok: ${name}` : `failed: ${name}: ${report.problem ?? "unexpected result"}`,
        );
        failed = failed || !report.ok;
      } finally {
        await environment.stop();
      }
    }
    return failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}
