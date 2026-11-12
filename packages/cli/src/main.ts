import { CliError } from "./errors.ts";
import { processIo, type CliIo } from "./io.ts";
import { exampleCommand } from "./commands/example.ts";
import { migrateCommand, type DatabaseHooks } from "./commands/migrate.ts";
import { devCommand, workerCommand, type ProcessHooks } from "./commands/process.ts";
import { serveCommand } from "./commands/serve.ts";
import { runCommand } from "./commands/run.ts";
import { historyCommand, type HistoryHooks } from "./commands/history.ts";
import { replayCommand } from "./commands/replay.ts";

/**
 * Replacements for the effects commands reach for, used by tests.
 */
export interface CliHooks extends ProcessHooks, HistoryHooks, DatabaseHooks {}

/**
 * The text `wf help` prints.
 */
export const HELP_TEXT = `usage: wf <command> [options]

commands:
  dev                     start postgres, api, web ui and a worker in one process
  serve                   run the api and the web ui without a worker (production)
  worker                  run workflows and steps from modules against the database
  migrate [up|down]       apply pending migrations or revert the last ones (down asks first, --yes skips)
  run start <type>        start a run (--input json, --idempotency-key k, --wait)
  run signal <id> <name>  send a signal (--payload json)
  run cancel <id>         request cancellation (--reason text)
  run describe <id>       show a run (--history for its events)
  run list                list runs (--status s, --type t, --limit n)
  history export <id>     print the run's whole history as a history export (--out file)
  replay <file...>        replay history exports against --module code, exit 1 on non-determinism
  example <name|all>      run a bundled example end to end (payment-saga, etl-pipeline)
  help                    show this text

serve and worker options (each also reads WF_<NAME>, for example WF_POOL_SIZE):
  --pool-size n           database connections (default: the pg default of 10)
  --log-level l           debug, info, warn or error (default: info)
  --log-format f          json or text (default: json)
  --otlp-endpoint url     export traces to this OTLP HTTP endpoint
  --sampling-ratio r      share of new traces recorded, 0 to 1 (default: 1)
  --migrate               apply pending migrations first (default: refuse when behind)
serve only:
  --port n --host h       listen address (default: 8080 on 0.0.0.0)
  --namespace name        namespace of the api key (default: default); WF_API_KEY sets the key
  --max-concurrent-runs n --max-pending-tasks n --rate-per-second n --burst n
                          limits of the namespace
  --max-queue-depth n     answer 503 to writes while the queue holds this many tasks
  --metrics-token t       require this bearer token on /metrics
  --metrics-cache-ms n    serve one rendered scrape for this long
worker only:
  --queue name --concurrency n
  --health-port n         serve /health, /ready and /metrics on this port
  --health-host h         address for the health port (default: 0.0.0.0)
  --compact-interval s    compact closed runs every s seconds
  --compact-retention s   age of a closed run before compaction (default: 604800)
  --compact-tail-events n events kept per compacted run (default: 20)

common options:
  --database-url url      postgres connection string (default: DATABASE_URL)
  --api-url url           api address for run commands (default: WF_API_URL or .wf/dev.json)
  --api-key key           api key for run commands (default: WF_API_KEY or .wf/dev.json)
  --module file           workflow module exporting workflows and steps (repeatable)
  --example name          bundled example to load (repeatable)
  --json                  print machine readable output where supported`;

/**
 * Runs the cli with `argv` (the arguments after the program name) and
 * returns the exit code: 0 on success, 1 for a failed command, 2 for a usage
 * error.
 */
export async function main(
  argv: readonly string[],
  io: CliIo = processIo(),
  hooks: CliHooks = {},
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.stdout(HELP_TEXT);
        return command === undefined ? 2 : 0;
      case "dev":
        return await devCommand(rest, io, hooks);
      case "serve":
        return await serveCommand(rest, io, hooks);
      case "worker":
        return await workerCommand(rest, io, hooks);
      case "migrate":
        return await migrateCommand(rest, io, hooks);
      case "run":
        return await runCommand(rest, io, hooks);
      case "history":
        return await historyCommand(rest, io, hooks);
      case "replay":
        return await replayCommand(rest, io);
      case "example":
        return await exampleCommand(rest, io, hooks);
      default:
        io.stderr(`unknown command "${command}", run \`wf help\``);
        return 2;
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`error: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof Error && error.name === "ApiError") {
      io.stderr(`error: ${error.message}`);
      return 1;
    }
    io.stderr(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}
