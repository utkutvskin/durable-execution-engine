import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHistoryExport, InvalidHistoryExportError, readRunEventArchive } from "@dee/core";
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
 *
 * `wf history import <archive...> --out <dir>`: reads run event archives
 * (the NDJSON files the partition maintainer writes before it drops a
 * partition) and writes one history export per run to
 * `<dir>/<runId>.json`, for `wf replay`. A run that cannot be exported (its
 * oldest events were compacted) is reported on stderr and skipped.
 */
export async function historyCommand(
  args: readonly string[],
  io: CliIo,
  hooks: HistoryHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, { ...CLIENT_OPTIONS, out: { type: "string" } });
  const action = parsed.positionals[0];
  if (action === "import") {
    return importArchives(parsed.positionals.slice(1), stringFlag(parsed, "out"), io, hooks);
  }
  if (action !== "export") {
    throw new CliError(
      action === undefined
        ? "missing history action: export or import"
        : `unknown history action "${action}": use export or import`,
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

async function importArchives(
  files: readonly string[],
  out: string | undefined,
  io: CliIo,
  hooks: HistoryHooks,
): Promise<number> {
  if (files.length === 0) {
    throw new CliError("missing archive file: wf history import <archive...> --out <dir>", 2);
  }
  if (out === undefined) {
    throw new CliError("missing --out <dir> for wf history import", 2);
  }
  const directory = path.resolve(io.cwd, out);
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const text = await readFile(path.resolve(io.cwd, file), "utf8").catch((error: unknown) => {
      throw new CliError(
        `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    let contents;
    try {
      contents = readRunEventArchive(text, file, hooks.now?.());
    } catch (error) {
      if (error instanceof InvalidHistoryExportError) {
        throw new CliError(error.message);
      }
      throw error;
    }
    for (const history of contents.histories) {
      await writeFile(
        path.join(directory, `${history.runId}.json`),
        `${JSON.stringify(history, null, 2)}\n`,
        "utf8",
      );
    }
    for (const skipped of contents.unreadable) {
      io.stderr(`skipped run ${skipped.runId}: ${skipped.reason}`);
    }
    io.stdout(
      `imported ${String(contents.histories.length)} runs of ${contents.partition} from ${file} to ${out}`,
    );
  }
  return 0;
}
