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
  if (reason instanceof Error) {
    return reason.stack === undefined
      ? { name: reason.name, message: reason.message }
      : { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return { name: "Error", message: toMessage(reason) };
}

/**
 * Reconstructs an `Error` from a `SerializedError`: the result's `name` and
 * `message` match what was serialized, and its `stack` is overwritten with
 * the original stack when one was captured, so a reader sees where the
 * error actually happened rather than where it was reconstructed.
 */
export function deserializeError(serialized: SerializedError): Error {
  const reconstructed = new Error(serialized.message);
  reconstructed.name = serialized.name;
  if (serialized.stack !== undefined) {
    reconstructed.stack = serialized.stack;
  }
  return reconstructed;
}
