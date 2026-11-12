import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatReplayResult, replayHistories, type HistoryToReplay } from "@dee/core";
import { CliError } from "../errors.ts";
import type { CliIo } from "../io.ts";
import { selectedModule } from "./process.ts";
import { booleanFlag, parseCommand, stringFlag } from "./shared.ts";

async function readHistoryFile(io: CliIo, file: string): Promise<HistoryToReplay> {
  let text: string;
  try {
    text = await readFile(path.resolve(io.cwd, file), "utf8");
  } catch (error) {
    throw new CliError(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return { source: file, history: JSON.parse(text) as unknown };
  } catch {
    return { source: file, history: undefined };
  }
}

/**
 * `wf replay --module <path>... <file...>`: replays each history export
 * against the workflows of the modules and prints one line per file. Exits
 * 0 when every history replays, 1 when one does not (non-determinism, a
 * changed outcome, an unknown workflow type or an unreadable file) and 2 on
 * a usage error. `--json` prints the whole report instead.
 */
export async function replayCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCommand(args, {
    module: { type: "string", multiple: true },
    example: { type: "string", multiple: true },
    "build-id": { type: "string" },
    json: { type: "boolean" },
  });
  if (parsed.positionals.length === 0) {
    throw new CliError("no history files: pass one or more files `wf history export` wrote", 2);
  }
  const module = await selectedModule(parsed, io, false);
  const histories: HistoryToReplay[] = [];
  for (const file of parsed.positionals) {
    histories.push(await readHistoryFile(io, file));
  }
  const buildId = stringFlag(parsed, "build-id");
  const report = await replayHistories(
    module.workflows,
    histories,
    buildId === undefined ? {} : { buildId },
  );
  if (booleanFlag(parsed, "json")) {
    io.stdout(JSON.stringify(report));
  } else {
    for (const result of report.results) {
      (result.passed ? io.stdout : io.stderr)(formatReplayResult(result));
    }
    io.stdout(`${String(report.passed)} passed, ${String(report.failed)} failed`);
  }
  return report.failed === 0 ? 0 : 1;
}
