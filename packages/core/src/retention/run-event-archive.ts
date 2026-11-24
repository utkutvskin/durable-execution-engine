import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createHistoryExport,
  InvalidHistoryExportError,
  type HistoryExport,
} from "../replay/history-export.ts";

/**
 * The `format` value on the first line of every run event archive.
 */
export const RUN_EVENT_ARCHIVE_FORMAT = "dee.run-events-archive";

/**
 * The version of the archive layout this build writes and reads.
 */
export const RUN_EVENT_ARCHIVE_FORMAT_VERSION = 1;

/**
 * The partition an archive holds: its table name and its range of run
 * creation times (`lowerBound` is `null` for the partition that starts at
 * the beginning of time).
 */
export interface ArchivedPartition {
  readonly name: string;
  readonly lowerBound: Date | null;
  readonly upperBound: Date;
}

/**
 * One event line of an archive. `event` is the stored payload, decoded by
 * the engine's codec but not otherwise interpreted, so an archive keeps
 * events of any format version as they were written.
 */
export interface ArchivedEvent {
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly version: number;
  readonly event: { readonly type: string } & Readonly<Record<string, unknown>>;
}

/**
 * Where the partition maintainer writes a partition before it drops it.
 * `write` receives the archive's lines (each one JSON document, without
 * the newline) and resolves with the location it wrote, once the archive
 * is durable. A rejection keeps the partition.
 */
export interface RunEventArchive {
  write(partition: ArchivedPartition, lines: AsyncIterable<string>): Promise<string>;
}

/**
 * Renders the header line of an archive of `partition`.
 */
export function archiveHeaderLine(partition: ArchivedPartition, archivedAt: Date): string {
  return JSON.stringify({
    format: RUN_EVENT_ARCHIVE_FORMAT,
    formatVersion: RUN_EVENT_ARCHIVE_FORMAT_VERSION,
    partition: partition.name,
    lowerBound: partition.lowerBound?.toISOString() ?? null,
    upperBound: partition.upperBound.toISOString(),
    archivedAt: archivedAt.toISOString(),
  });
}

/**
 * An archive that writes each partition to `<directory>/<partition>.ndjson`
 * (newline-delimited JSON). The file is written under a temporary name,
 * flushed to disk and then renamed, so a file with the final name is always
 * complete.
 */
export function createDirectoryArchive(directory: string): RunEventArchive {
  return {
    async write(partition, lines) {
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, `${partition.name}.ndjson`);
      const partial = `${target}.partial`;
      const handle = await open(partial, "w");
      try {
        for await (const line of lines) {
          await handle.write(`${line}\n`);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(partial, target);
      return target;
    },
  };
}

const headerSchema = z.object({
  format: z.literal(RUN_EVENT_ARCHIVE_FORMAT),
  formatVersion: z.number().int().min(1),
  partition: z.string().min(1),
});

const eventLineSchema = z.object({
  runId: z.string().min(1),
  sequenceNumber: z.number().int().min(1),
  createdAt: z.string().min(1),
  version: z.number().int().min(1),
  event: z.looseObject({ type: z.string().min(1) }),
});

/**
 * A run of an archive that could not be turned into a history export, with
 * the reason (for example a run whose oldest events were compacted away).
 */
export interface UnreadableArchivedRun {
  readonly runId: string;
  readonly reason: string;
}

/**
 * What `readRunEventArchive` found: one history export per whole run, in
 * the order the runs first appear, and the runs it had to leave out.
 */
export interface ArchiveContents {
  readonly partition: string;
  readonly histories: readonly HistoryExport[];
  readonly unreadable: readonly UnreadableArchivedRun[];
}

/**
 * Reads the text of a run event archive (`source` names it in errors) and
 * turns every run in it into a history export that `wf replay` and
 * `replayHistories` read. Throws `InvalidHistoryExportError` when the text
 * is not an archive this build can read.
 */
export function readRunEventArchive(
  text: string,
  source: string,
  exportedAt: Date = new Date(),
): ArchiveContents {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const [headerLine, ...eventLines] = lines;
  if (headerLine === undefined) {
    throw new InvalidHistoryExportError(source, "the archive is empty");
  }
  const header = headerSchema.safeParse(parseLine(headerLine, source, 1));
  if (!header.success) {
    throw new InvalidHistoryExportError(
      source,
      `not a run event archive: ${z.prettifyError(header.error)}`,
    );
  }
  if (header.data.formatVersion > RUN_EVENT_ARCHIVE_FORMAT_VERSION) {
    throw new InvalidHistoryExportError(
      source,
      `archive format version ${String(header.data.formatVersion)} is newer than ` +
        `${String(RUN_EVENT_ARCHIVE_FORMAT_VERSION)}, the newest this build reads`,
    );
  }
  const runs = new Map<string, ArchivedEvent[]>();
  for (const [index, line] of eventLines.entries()) {
    const parsed = eventLineSchema.safeParse(parseLine(line, source, index + 2));
    if (!parsed.success) {
      throw new InvalidHistoryExportError(
        source,
        `line ${String(index + 2)} is not an archived event: ${z.prettifyError(parsed.error)}`,
      );
    }
    const events = runs.get(parsed.data.runId) ?? [];
    events.push(parsed.data);
    runs.set(parsed.data.runId, events);
  }
  const histories: HistoryExport[] = [];
  const unreadable: UnreadableArchivedRun[] = [];
  for (const [runId, events] of runs) {
    const ordered = [...events].sort((left, right) => left.sequenceNumber - right.sequenceNumber);
    try {
      histories.push(createHistoryExport({ runId, events: ordered, exportedAt }));
    } catch (error) {
      if (!(error instanceof InvalidHistoryExportError)) {
        throw error;
      }
      unreadable.push({ runId, reason: error.message });
    }
  }
  return { partition: header.data.partition, histories, unreadable };
}

function parseLine(line: string, source: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new InvalidHistoryExportError(source, `line ${String(lineNumber)} is not JSON`);
  }
}
