import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHistoryExport, InvalidHistoryExportError } from "@dee/core";
import { CliError } from "../errors.ts";
import type { CliIo } from "../io.ts";
import { parseCommand, requirePositional, stringFlag } from "./shared.ts";
import { CLIENT_OPTIONS, clientFor, type RunHooks } from "./run.ts";

/**
 * Hooks of `wf history`: tests hand in a client and a fixed export time.
 */
export interface HistoryHooks extends RunHooks {
  readonly now?: () => Date;
}

/**
 * `wf history export <runId> [--out file]`: reads the run's whole history
 * through the api and prints it as a history export (JSON), or writes it to
 * `--out`. A compacted run, which has lost its oldest events, is refused.
 */
export async function historyCommand(
  args: readonly string[],
  io: CliIo,
  hooks: HistoryHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, { ...CLIENT_OPTIONS, out: { type: "string" } });
  const action = parsed.positionals[0];
  if (action !== "export") {
    throw new CliError(
      action === undefined
        ? "missing history action: export"
        : `unknown history action "${action}": use export`,
      2,
    );
  }
  const runId = requirePositional(parsed, 1, "run id");
  const client = await clientFor(parsed, io, hooks);
  const events = await client.history(runId);
  let exported;
  try {
    exported = createHistoryExport({
      runId,
      events,
      ...(hooks.now === undefined ? {} : { exportedAt: hooks.now() }),
    });
  } catch (error) {
    if (error instanceof InvalidHistoryExportError) {
      throw new CliError(error.message);
    }
    throw error;
  }
  const text = JSON.stringify(exported, null, 2);
  const out = stringFlag(parsed, "out");
  if (out === undefined) {
    io.stdout(text);
    return 0;
  }
  await writeFile(path.resolve(io.cwd, out), `${text}\n`, "utf8");
  io.stderr(`exported ${String(exported.events.length)} events of run ${runId} to ${out}`);
  return 0;
}
