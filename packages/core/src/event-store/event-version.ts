import { workflowEventSchema, type WorkflowEvent } from "./events.ts";

/**
 * The version of the history event format this build writes. Every stored
 * event carries the version it was written with (`run_events.event_version`).
 * It goes up only when an event gains a meaning an older reader cannot
 * safely ignore, such as a new event type; a new optional field does not
 * raise it. See `docs/STABILITY.md`.
 */
export const CURRENT_EVENT_VERSION = 1;

/**
 * The event types this build knows, in the order `workflowEventSchema`
 * declares them.
 */
export const KNOWN_EVENT_TYPES: readonly WorkflowEvent["type"][] = workflowEventSchema.options.map(
  (option) => option.shape.type.value,
);

/**
 * Thrown when a stored event cannot be read by this build: its version is
 * not a positive whole number, or it was written by a newer version and has
 * a type this build does not know. `eventType` is `undefined` when the
 * payload has no string `type`.
 */
export class UnsupportedEventError extends Error {
  readonly eventType: string | undefined;
  readonly version: number;

  constructor(eventType: string | undefined, version: number, reason: string) {
    super(
      `cannot read history event${eventType === undefined ? "" : ` "${eventType}"`} ` +
        `of version ${String(version)}: ${reason}`,
    );
    this.name = "UnsupportedEventError";
    this.eventType = eventType;
    this.version = version;
  }
}

function typeOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const type = (raw as Record<string, unknown>)["type"];
  return typeof type === "string" ? type : undefined;
}

/**
 * The event schema a reader applies: the event types it knows and how it
 * validates one payload. `currentEventReader` is this build's; a test can
 * hand in another to check how a changed schema treats stored histories.
 */
export interface EventReader {
  readonly knownTypes: readonly string[];
  parse(raw: unknown): WorkflowEvent;
}

/**
 * The `EventReader` of this build: `KNOWN_EVENT_TYPES` and
 * `workflowEventSchema`.
 */
export const currentEventReader: EventReader = {
  knownTypes: KNOWN_EVENT_TYPES,
  parse: (raw) => workflowEventSchema.parse(raw),
};

/**
 * Reads one decoded event payload written with format `version`. An event
 * of this build's version or older must match the reader's schema. An
 * event of a newer version is read forward-compatibly: fields this build
 * does not know are dropped, and only a type it does not know is refused,
 * with `UnsupportedEventError`, instead of a schema error. The returned
 * event never carries fields outside the schema.
 */
export function readVersionedEvent(
  raw: unknown,
  version: number,
  reader: EventReader = currentEventReader,
): WorkflowEvent {
  const eventType = typeOf(raw);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new UnsupportedEventError(eventType, version, "a version is a whole number from 1");
  }
  if (
    version > CURRENT_EVENT_VERSION &&
    (eventType === undefined || !reader.knownTypes.includes(eventType))
  ) {
    throw new UnsupportedEventError(
      eventType,
      version,
      `it was written by a newer event format (this build reads up to version ` +
        `${String(CURRENT_EVENT_VERSION)}) and its type is unknown here; upgrade the engine`,
    );
  }
  return reader.parse(raw);
}
