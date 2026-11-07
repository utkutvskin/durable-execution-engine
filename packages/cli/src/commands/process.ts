import { createHealthChecks, createPool, migrateUp, pendingMigrations, type Pool } from "@dee/core";
import { startEngine, startOpsServer, type OpsServer } from "@dee/worker";
import { databaseUrl, ensureDatabase, findComposeDirectory, isProduction } from "../database.js";
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
  COMPACTION_OPTIONS,
  OPS_OPTIONS,
  RUNTIME_OPTIONS,
  createCliLogger,
  createCliTracing,
  flagOrEnv,
  integerOption,
  parseCompactionSettings,
  parseOpsSettings,
  parseRuntimeSettings,
} from "./runtime-flags.js";
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

/**
 * Resolves on the first `SIGINT` or `SIGTERM` of the process.
 */
export function untilSignal(): Promise<void> {
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

/**
 * Loads and merges the workflow modules named by `--module` and `--example`.
 * Without any, it loads the bundled examples when `defaultToExamples`, else
 * fails with a usage error.
 */
export async function selectedModule(
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

/**
 * Settings of `openPool`: the pool size, and `allowCompose` (default true
 * outside production) which lets the command start the compose postgres
 * service when the database does not answer.
 */
export interface OpenPoolOptions {
  readonly poolSize?: number | undefined;
  readonly allowCompose?: boolean;
}

/**
 * Makes sure the database answers and opens a pool on it. Docker compose is
 * only an option when `NODE_ENV` is not `production` and the command allows
 * it. The pool keeps its idle connections open, because a process that also
 * decides workflows patches the timers an idle timeout would use.
 */
export async function openPool(
  parsed: ParsedCommand,
  io: CliIo,
  hooks: DatabaseHooks,
  options: OpenPoolOptions = {},
): Promise<Pool> {
  const url = databaseUrl(stringFlag(parsed, "database-url"), io.env);
  const composeAllowed = (options.allowCompose ?? true) && !isProduction(io.env);
  await ensureDatabase({
    url,
    composeDirectory: composeAllowed ? findComposeDirectory(io.cwd) : undefined,
    composeAllowed,
    log: io.stderr,
    ...(hooks.databaseEffects === undefined ? {} : { effects: hooks.databaseEffects }),
  });
  return createPool(
    { DATABASE_URL: url },
    {
      idleTimeoutMillis: 0,
      ...(options.poolSize === undefined ? {} : { max: options.poolSize }),
      onError: (error) => {
        io.stderr(`database error: ${error.message}`);
      },
    },
  );
}

/**
 * The options that choose the database and the workflow modules.
 */
export const MODULE_OPTIONS = {
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
    try {
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
    } finally {
      await environment.stop();
    }
    return 0;
  } finally {
    await pool.end();
  }
}

/**
 * `wf worker [--module file]... [--example name]... [--queue name]
 * [--concurrency n] [--migrate] [--pool-size n] [--log-level l]
 * [--log-format json|text] [--otlp-endpoint url] [--sampling-ratio r]
 * [--health-port n] [--health-host h] [--metrics-token t]
 * [--compact-interval s] [--compact-retention s] [--compact-tail-events n]
 * [--compact-batch n]`: runs workflows and steps from the chosen modules
 * against the database, without an api. With `--health-port` it serves
 * `/health`, `/ready` and `/metrics` there. With `--compact-interval` it
 * compacts runs that closed `--compact-retention` seconds ago (default one
 * week) every that many seconds. It never starts docker compose when
 * `NODE_ENV=production`, and refuses to run on a schema that is behind
 * (`wf migrate up`, or `--migrate`). It runs until `SIGINT` or `SIGTERM`,
 * finishing the tasks it holds first.
 */
export async function workerCommand(
  args: readonly string[],
  io: CliIo,
  hooks: ProcessHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...MODULE_OPTIONS,
    ...RUNTIME_OPTIONS,
    ...COMPACTION_OPTIONS,
    ...OPS_OPTIONS,
    queue: { type: "string" },
    concurrency: { type: "string" },
    migrate: { type: "boolean" },
  });
  const settings = parseRuntimeSettings(parsed, io.env);
  const concurrency = integerOption(parsed, "concurrency", io.env, 1, 10_000) ?? 4;
  const compaction = parseCompactionSettings(parsed, io.env);
  const ops = parseOpsSettings(parsed, io.env);
  const module = await selectedModule(parsed, io, false);
  const logger = createCliLogger(settings, io, { service: "wf-worker" });
  const pool = await openPool(parsed, io, hooks, { poolSize: settings.poolSize });
  const tracing = createCliTracing(settings, "wf-worker");
  try {
    if (booleanFlag(parsed, "migrate")) {
      await migrateUp(pool);
    }
    const pending = await pendingMigrations(pool);
    if (pending.length > 0) {
      throw new CliError(
        `the schema is behind by ${String(pending.length)} migration(s): run \`wf migrate up\` or pass --migrate`,
      );
    }
    const queue = flagOrEnv(parsed, "queue", io.env);
    const engine = startEngine({
      pool,
      workflows: module.workflows,
      steps: module.steps,
      concurrency,
      ...(queue === undefined ? {} : { queueName: queue }),
      ...(tracing === undefined ? {} : { tracing: tracing.tracing }),
      ...(compaction === undefined
        ? {}
        : {
            compaction: {
              intervalMs: compaction.intervalMs,
              policy: compaction.policy,
              ...(compaction.batchSize === undefined ? {} : { batchSize: compaction.batchSize }),
            },
          }),
      onError: (error) => {
        logger.error("worker error", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    let opsServer: OpsServer | undefined;
    try {
      if (ops !== undefined) {
        opsServer = await startOpsServer({
          health: createHealthChecks(pool),
          metrics: engine.metrics,
          port: ops.port,
          host: ops.host,
          ...(ops.metricsToken === undefined ? {} : { metricsToken: ops.metricsToken }),
          onError: (error) => {
            logger.error("ops server error", {
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
      }
    } catch (error) {
      await engine.stop();
      throw error;
    }
    logger.info("worker running", {
      workflows: module.workflows.length,
      steps: module.steps.length,
      queue: engine.queueName,
      workerId: engine.workerId,
      concurrency,
      ...(opsServer === undefined ? {} : { opsPort: opsServer.port }),
      compaction: compaction !== undefined,
    });
    await (hooks.shutdown ?? untilSignal)();
    logger.info("stopping");
    await opsServer?.stop();
    const stopped = await engine.stop();
    return stopped.dropped === 0 ? 0 : 1;
  } finally {
    await tracing?.shutdown().catch(() => undefined);
    await pool.end();
  }
}
