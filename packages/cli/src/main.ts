import { CliError } from "./errors.js";
import { processIo, type CliIo } from "./io.js";
import { exampleCommand } from "./commands/example.js";
import { migrateCommand, type DatabaseHooks } from "./commands/migrate.js";
import { devCommand, workerCommand, type ProcessHooks } from "./commands/process.js";
import { runCommand, type RunHooks } from "./commands/run.js";

/**
 * Replacements for the effects commands reach for, used by tests.
 */
export interface CliHooks extends ProcessHooks, RunHooks, DatabaseHooks {}

/**
 * The text `wf help` prints.
 */
export const HELP_TEXT = `usage: wf <command> [options]

commands:
  dev                     start postgres, api, web ui and a worker in one process
  worker                  run workflows and steps from modules against the database
  migrate [up|down]       apply pending migrations or revert the last ones
  run start <type>        start a run (--input json, --idempotency-key k, --wait)
  run signal <id> <name>  send a signal (--payload json)
  run cancel <id>         request cancellation (--reason text)
  run describe <id>       show a run (--history for its events)
  run list                list runs (--status s, --type t, --limit n)
  example <name|all>      run a bundled example end to end (payment-saga, etl-pipeline)
  help                    show this text

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
      case "worker":
        return await workerCommand(rest, io, hooks);
      case "migrate":
        return await migrateCommand(rest, io, hooks);
      case "run":
        return await runCommand(rest, io, hooks);
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
