import { createWorkflowRegistry, pendingMigrations, migrateUp } from "@dee/core";
import { isProduction } from "../database.ts";
import { CliError } from "../errors.ts";
import type { CliIo } from "../io.ts";
import { startServeEnvironment } from "../serve-environment.ts";
import {
  MODULE_OPTIONS,
  openPool,
  selectedModule,
  untilSignal,
  type ProcessHooks,
} from "./process.ts";
import {
  QUOTA_OPTIONS,
  RUNTIME_OPTIONS,
  createCliLogger,
  createCliTracing,
  flagOrEnv,
  integerOption,
  parseRuntimeSettings,
  parseServeLimits,
} from "./runtime-flags.ts";
import { booleanFlag, parseCommand, stringFlags } from "./shared.ts";

/**
 * `wf serve [--port n] [--host h] [--namespace name] [--queue name]
 * [--migrate] [--module file]... [--example name]... [--pool-size n]
 * [--log-level l] [--log-format json|text] [--otlp-endpoint url]
 * [--sampling-ratio r] [--max-concurrent-runs n] [--max-pending-tasks n]
 * [--rate-per-second n] [--burst n] [--max-queue-depth n] [--metrics-token t]
 * [--metrics-cache-ms n]`: runs the api and the web ui without a worker.
 *
 * The api key comes from `WF_API_KEY` (registered for the namespace) or from
 * a key the namespace already has; only a namespace without any key gets a
 * new one, logged once. The schema must be current (`wf migrate up`, or
 * `--migrate`). Every line it writes is a structured log line. The modules
 * are optional: with them, starting a run of an unknown type answers 400.
 * It runs until `SIGINT` or `SIGTERM`.
 */
export async function serveCommand(
  args: readonly string[],
  io: CliIo,
  hooks: ProcessHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...MODULE_OPTIONS,
    ...RUNTIME_OPTIONS,
    ...QUOTA_OPTIONS,
    port: { type: "string" },
    host: { type: "string" },
    namespace: { type: "string" },
    queue: { type: "string" },
    migrate: { type: "boolean" },
  });
  const settings = parseRuntimeSettings(parsed, io.env);
  const limits = parseServeLimits(parsed, io.env);
  const port = integerOption(parsed, "port", io.env, 0, 65535) ?? 8080;
  const host = flagOrEnv(parsed, "host", io.env) ?? "0.0.0.0";
  const namespace = flagOrEnv(parsed, "namespace", io.env) ?? "default";
  const queueName = flagOrEnv(parsed, "queue", io.env) ?? "default";
  const logger = createCliLogger(settings, io, { service: "wf-serve" });
  const wantsModules =
    stringFlags(parsed, "module").length > 0 || stringFlags(parsed, "example").length > 0;
  const module = wantsModules ? await selectedModule(parsed, io, false) : undefined;
  const workflows = module === undefined ? undefined : createWorkflowRegistry();
  for (const entry of module?.workflows ?? []) {
    workflows?.register(entry);
  }
  const pool = await openPool(parsed, io, hooks, { poolSize: settings.poolSize });
  const tracing = createCliTracing(settings, "wf-serve");
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
    const environment = await startServeEnvironment({
      pool,
      namespace,
      queueName,
      port,
      host,
      apiKey: io.env["WF_API_KEY"] === "" ? undefined : io.env["WF_API_KEY"],
      limits,
      logger,
      tracing: tracing?.tracing,
      workflows,
    });
    try {
      logger.info("api listening", {
        url: environment.url,
        namespace: environment.namespace,
        queue: queueName,
        production: isProduction(io.env),
        keySource: environment.keySource,
      });
      if (environment.issuedKey !== undefined) {
        logger.warn("issued a new api key, it is shown once", {
          namespace: environment.namespace,
          apiKey: environment.issuedKey,
        });
      }
      await (hooks.shutdown ?? untilSignal)();
      logger.info("stopping");
    } finally {
      await environment.stop();
    }
    return 0;
  } finally {
    await tracing?.shutdown().catch(() => undefined);
    await pool.end();
  }
}
