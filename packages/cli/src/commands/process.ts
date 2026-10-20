import { createPool, type Pool } from "@dee/core";
import { startEngine } from "@dee/worker";
import { databaseUrl, ensureDatabase, findComposeDirectory } from "../database.js";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import {
  EXAMPLE_NAMES,
  loadExample,
  loadWorkflowModule,
  mergeModules,
  type ExampleName,
  type WorkflowModule,
} from "../modules.js";
import { writeDevState } from "../config.js";
import { startDevEnvironment } from "../dev-environment.js";
import type { DatabaseHooks } from "./migrate.js";
import {
  parseCommand,
  stringFlag,
  stringFlags,
  booleanFlag,
  type ParsedCommand,
} from "./shared.js";

/**
 * Hooks of the commands that run until stopped. `shutdown` resolves when the
 * process should stop; by default it resolves on the first `SIGINT` or
 * `SIGTERM`.
 */
export interface ProcessHooks extends DatabaseHooks {
  readonly shutdown?: () => Promise<void>;
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

async function selectedModule(
  parsed: ParsedCommand,
  io: CliIo,
  defaultToExamples: boolean,
): Promise<WorkflowModule> {
  const modules: WorkflowModule[] = [];
  for (const specifier of stringFlags(parsed, "module")) {
    modules.push(await loadWorkflowModule(specifier, io.cwd));
  }
  const requested = stringFlags(parsed, "example");
  for (const name of requested) {
    if (!(EXAMPLE_NAMES as readonly string[]).includes(name)) {
      throw new CliError(`unknown example "${name}": use ${EXAMPLE_NAMES.join(" or ")}`, 2);
    }
    modules.push(await loadExample(name as ExampleName));
  }
  if (modules.length === 0) {
    if (!defaultToExamples) {
      throw new CliError("no workflows: pass --module <file> or --example <name>", 2);
    }
    for (const name of EXAMPLE_NAMES) {
      modules.push(await loadExample(name));
    }
  }
  return mergeModules(modules);
}

async function openPool(parsed: ParsedCommand, io: CliIo, hooks: DatabaseHooks): Promise<Pool> {
  const url = databaseUrl(stringFlag(parsed, "database-url"), io.env);
  await ensureDatabase({
    url,
    composeDirectory: findComposeDirectory(io.cwd),
    log: io.stderr,
    ...(hooks.databaseEffects === undefined ? {} : { effects: hooks.databaseEffects }),
  });
  return createPool(
    { DATABASE_URL: url },
    {
      onError: (error) => {
        io.stderr(`database error: ${error.message}`);
      },
    },
  );
}

const MODULE_OPTIONS = {
  module: { type: "string", multiple: true },
  example: { type: "string", multiple: true },
  "database-url": { type: "string" },
} as const;

/**
 * `wf dev [--port n] [--host h] [--namespace name] [--module file]...
 * [--example name]... [--verbose]`: brings up everything for local work in
 * one process. It makes sure Postgres answers (starting the compose service
 * when it does not), applies the migrations, serves the api and the web ui,
 * runs a worker for the chosen modules (both bundled examples when none is
 * chosen) and writes the api address and a fresh key to `.wf/dev.json` so
 * `wf run` works without flags. It runs until `SIGINT` or `SIGTERM`.
 */
export async function devCommand(
  args: readonly string[],
  io: CliIo,
  hooks: ProcessHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...MODULE_OPTIONS,
    port: { type: "string" },
    host: { type: "string" },
    namespace: { type: "string" },
    verbose: { type: "boolean" },
  });
  const port = Number(stringFlag(parsed, "port") ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError("--port must be a port number", 2);
  }
  const host = stringFlag(parsed, "host");
  const namespace = stringFlag(parsed, "namespace");
  const module = await selectedModule(parsed, io, true);
  const pool = await openPool(parsed, io, hooks);
  try {
    const environment = await startDevEnvironment({
      pool,
      module,
      port,
      ...(host === undefined ? {} : { host }),
      ...(namespace === undefined ? {} : { namespace }),
      onError: (error) => {
        io.stderr(`engine error: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    await writeDevState(io.cwd, {
      apiUrl: environment.url,
      apiKey: environment.apiKey,
      namespace: environment.namespace,
    });
    io.stdout(`api and ui listening on ${environment.url} (ui at ${environment.url}/ui/)`);
    io.stdout(`namespace ${environment.namespace}, api key ${environment.apiKey}`);
    io.stdout(`workflows: ${module.workflows.map((entry) => entry.workflowType).join(", ")}`);
    io.stdout("api address and key saved to .wf/dev.json, try `wf run list`");
    if (booleanFlag(parsed, "verbose")) {
      io.stdout("verbose output is on");
    }
    await (hooks.shutdown ?? untilSignal)();
    io.stdout("stopping");
    await environment.stop();
    return 0;
  } finally {
    await pool.end();
  }
}

/**
 * `wf worker [--module file]... [--example name]... [--queue name]
 * [--concurrency n]`: runs workflows and steps from the chosen modules
 * against the database, without an api. It runs until `SIGINT` or
 * `SIGTERM`, finishing the tasks it holds first.
 */
export async function workerCommand(
  args: readonly string[],
  io: CliIo,
  hooks: ProcessHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...MODULE_OPTIONS,
    queue: { type: "string" },
    concurrency: { type: "string" },
  });
  const concurrency = Number(stringFlag(parsed, "concurrency") ?? "4");
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new CliError("--concurrency must be a positive integer", 2);
  }
  const module = await selectedModule(parsed, io, false);
  const pool = await openPool(parsed, io, hooks);
  try {
    const queue = stringFlag(parsed, "queue");
    const engine = startEngine({
      pool,
      workflows: module.workflows,
      steps: module.steps,
      concurrency,
      ...(queue === undefined ? {} : { queueName: queue }),
      onError: (error) => {
        io.stderr(`worker error: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    io.stdout(
      `worker running ${String(module.workflows.length)} workflows and ${String(module.steps.length)} steps on queue ${engine.queueName}`,
    );
    await (hooks.shutdown ?? untilSignal)();
    io.stdout("stopping");
    const stopped = await engine.stop();
    return stopped.dropped === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}
