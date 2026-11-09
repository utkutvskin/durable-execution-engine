import type { RecordedError } from "../event-store/events.ts";

/**
 * The wire form of an `Error`: everything a step's thrown error needs to
 * survive a trip through storage and be read back later, whether for a
 * dead-letter entry, a diagnostic view, or a future retry decision. `name`
 * is what carries the error's "type" across that trip, since a custom
 * error class only exists as a name string once serialized, not as a
 * constructor a reader can call.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly details?: unknown;
  readonly cause?: SerializedError | undefined;
}

const MAX_CAUSE_DEPTH = 5;
const RESERVED_ERROR_KEYS: ReadonlySet<string> = new Set(["name", "message", "stack", "cause"]);

function toJsonValue(value: unknown): unknown {
  try {
    const text = JSON.stringify(value) as string | undefined;
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function collectDetails(error: Error): unknown {
  const details: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (RESERVED_ERROR_KEYS.has(key)) {
      continue;
    }
    const value = toJsonValue((error as unknown as Record<string, unknown>)[key]);
    if (value !== undefined) {
      details[key] = value;
    }
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

function toMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return JSON.stringify(reason);
}

/**
 * Captures whatever a step handler threw as a `SerializedError`: an
 * `Error` (including a custom subclass) keeps its `name`, `message` and
 * `stack`, while a non-`Error` throw is normalized to `name: "Error"` with
 * a best-effort `message`.
 */
export function serializeError(reason: unknown): SerializedError {
  return serializeAtDepth(reason, 0);
}

function serializeAtDepth(reason: unknown, depth: number): SerializedError {
  if (!(reason instanceof Error)) {
    return { name: "Error", message: toMessage(reason) };
  }
  const details = collectDetails(reason);
  const cause =
    reason.cause === undefined || depth >= MAX_CAUSE_DEPTH
      ? undefined
      : serializeAtDepth(reason.cause, depth + 1);
  return {
    name: reason.name,
    message: reason.message,
    ...(reason.stack === undefined ? {} : { stack: reason.stack }),
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  };
}

/**
 * Reconstructs an `Error` from a `SerializedError`: the result's `name` and
 * `message` match what was serialized, and its `stack` is overwritten with
 * the original stack when one was captured, so a reader sees where the
 * error actually happened rather than where it was reconstructed. The
 * serializable `details` come back as a `details` property and the `cause`
 * chain as `cause`, each rebuilt the same way.
 */
export function deserializeError(serialized: SerializedError): Error {
  const reconstructed =
    serialized.cause === undefined
      ? new Error(serialized.message)
      : new Error(serialized.message, { cause: deserializeError(serialized.cause) });
  reconstructed.name = serialized.name;
  if (serialized.stack !== undefined) {
    reconstructed.stack = serialized.stack;
  }
  if (serialized.details !== undefined) {
    Object.defineProperty(reconstructed, "details", {
      value: serialized.details,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return reconstructed;
}

/**
 * The form of an `Error` that failure events keep: `serializeError` without
 * the stack, which is large and meaningless once the error has crossed
 * processes.
 */
export function toRecordedError(reason: unknown): RecordedError {
  const { stack: _stack, ...recorded } = serializeError(reason);
  return recorded;
}
