import { z } from "zod";
import {
  currentEventReader,
  readVersionedEvent,
  type EventReader,
} from "../event-store/event-version.ts";
import type { WorkflowEvent } from "../event-store/events.ts";

/**
 * The `format` value every history export carries.
 */
export const HISTORY_EXPORT_FORMAT = "dee.history";

/**
 * The version of the export envelope this build writes. The events inside
 * carry their own event format version.
 */
export const HISTORY_EXPORT_FORMAT_VERSION = 1;

/**
 * One event of an exported history, as `wf history export` writes it.
 * `version` is the event format version the event was written with.
 */
export interface ExportedEvent {
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly version: number;
  readonly event: { readonly type: string } & Readonly<Record<string, unknown>>;
}

/**
 * A run's full history in the file format `wf history export` writes and
 * `wf replay` and `replayHistories` read.
 */
export interface HistoryExport {
  readonly format: typeof HISTORY_EXPORT_FORMAT;
  readonly formatVersion: number;
  readonly runId: string;
  readonly workflowType: string;
  readonly exportedAt: string;
  readonly events: readonly ExportedEvent[];
}

/**
 * A history export after its events were read with this build's event
 * schema: `events[i].event` is a validated `WorkflowEvent`.
 */
export interface ParsedHistory {
  readonly runId: string;
  readonly workflowType: string;
  readonly events: readonly {
    readonly sequenceNumber: number;
    readonly createdAt: Date;
    readonly version: number;
    readonly event: WorkflowEvent;
  }[];
}

/**
 * Thrown when a file is not a history export this build can read. `source`
 * names the file (or whatever the caller passed) and `sequenceNumber` the
 * event at fault, when there is one.
 */
export class InvalidHistoryExportError extends Error {
  readonly source: string;
  readonly sequenceNumber: number | undefined;

  constructor(source: string, reason: string, sequenceNumber?: number) {
    super(
      `${source}: ${sequenceNumber === undefined ? "" : `event ${String(sequenceNumber)}: `}${reason}`,
    );
    this.name = "InvalidHistoryExportError";
    this.source = source;
    this.sequenceNumber = sequenceNumber;
  }
}

const envelopeSchema = z.object({
  format: z.literal(HISTORY_EXPORT_FORMAT),
  formatVersion: z.number().int().min(1),
  runId: z.string().min(1),
  workflowType: z.string().min(1),
  exportedAt: z.string().min(1),
  events: z.array(
    z.object({
      sequenceNumber: z.number().int().positive(),
      createdAt: z.iso.datetime({ offset: true }),
      version: z.number().int().optional(),
      event: z.looseObject({ type: z.string() }),
    }),
  ),
});

/**
 * One event handed to `createHistoryExport`. `version` defaults to 1, the
 * version every event had before versions were stored.
 */
export interface HistoryExportInputEvent {
  readonly sequenceNumber: number;
  readonly createdAt: Date | string;
  readonly version?: number;
  readonly event: { readonly type: string };
}

/**
 * Builds the export of `runId` from its events in sequence order. Rejects
 * with `InvalidHistoryExportError` when the events are not a whole history:
 * the first must be `run_started` at sequence number 1 (a compacted run has
 * lost its oldest events and cannot be exported) and the numbers must not
 * skip.
 */
export function createHistoryExport(input: {
  readonly runId: string;
  readonly events: readonly HistoryExportInputEvent[];
  readonly exportedAt?: Date;
}): HistoryExport {
  const source = `run ${input.runId}`;
  const first = input.events[0];
  if (first === undefined) {
    throw new InvalidHistoryExportError(source, "the run has no events");
  }
  if (first.sequenceNumber !== 1 || first.event.type !== "run_started") {
    throw new InvalidHistoryExportError(
      source,
      `the history starts at event ${String(first.sequenceNumber)} (${first.event.type}), ` +
        "not with run_started at 1; a compacted run cannot be exported",
    );
  }
  const events = input.events.map((entry, index): ExportedEvent => {
    if (entry.sequenceNumber !== index + 1) {
      throw new InvalidHistoryExportError(
        source,
        `expected sequence number ${String(index + 1)}`,
        entry.sequenceNumber,
      );
    }
    return {
      sequenceNumber: entry.sequenceNumber,
      createdAt:
        typeof entry.createdAt === "string" ? entry.createdAt : entry.createdAt.toISOString(),
      version: entry.version ?? 1,
      event: entry.event,
    };
  });
  const workflowType = (first.event as { readonly workflowType?: unknown }).workflowType;
  return {
    format: HISTORY_EXPORT_FORMAT,
    formatVersion: HISTORY_EXPORT_FORMAT_VERSION,
    runId: input.runId,
    workflowType: typeof workflowType === "string" ? workflowType : "",
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    events,
  };
}

/**
 * Reads `raw` (an already JSON-parsed export) with this build's envelope and
 * event schemas. Each event goes through `readVersionedEvent`, so an event
 * written by a newer version is read forward-compatibly. Rejects with
 * `InvalidHistoryExportError`, naming `source` and the event at fault, when
 * the envelope does not match, an event does not, the history does not
 * start with `run_started` at 1 or its sequence numbers skip. `reader`
 * defaults to this build's event schema.
 */
export function parseHistoryExport(
  raw: unknown,
  source = "history",
  reader: EventReader = currentEventReader,
): ParsedHistory {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new InvalidHistoryExportError(
      source,
      `not a history export: ${z.prettifyError(envelope.error)}`,
    );
  }
  if (envelope.data.formatVersion > HISTORY_EXPORT_FORMAT_VERSION) {
    throw new InvalidHistoryExportError(
      source,
      `export format version ${String(envelope.data.formatVersion)} is newer than ` +
        `${String(HISTORY_EXPORT_FORMAT_VERSION)}, the newest this build reads`,
    );
  }
  const events = envelope.data.events.map((entry, index) => {
    if (entry.sequenceNumber !== index + 1) {
      throw new InvalidHistoryExportError(
        source,
        `expected sequence number ${String(index + 1)}`,
        entry.sequenceNumber,
      );
    }
    const version = entry.version ?? 1;
    let event: WorkflowEvent;
    try {
      event = readVersionedEvent(entry.event, version, reader);
    } catch (error) {
      const reason =
        error instanceof z.ZodError
          ? `${entry.event.type} does not match the event schema: ${z.prettifyError(error)}`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new InvalidHistoryExportError(source, reason, entry.sequenceNumber);
    }
    return {
      sequenceNumber: entry.sequenceNumber,
      createdAt: new Date(entry.createdAt),
      version,
      event,
    };
  });
  const first = events[0]?.event;
  if (first?.type !== "run_started") {
    throw new InvalidHistoryExportError(source, "the history does not start with run_started");
  }
  return { runId: envelope.data.runId, workflowType: first.workflowType, events };
}
