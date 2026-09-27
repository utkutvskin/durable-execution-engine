/**
 * An error reduced to a plain, JSON-safe shape so it can travel through an
 * event payload and back. `name` is what a durable execution engine treats
 * as an error's "type": every custom error class in this codebase sets
 * `this.name` to its class name, so comparing or reconstructing on `name`
 * is exactly comparing on type without needing a class registry.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Reduces `error` to a `SerializedError`. `stack` is omitted when the
 * runtime never populated one, which keeps `JSON.stringify` from writing an
 * explicit `"stack": undefined` that would round-trip as a present key with
 * an absent value.
 */
export function serializeError(error: Error): SerializedError {
  return error.stack === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, message: error.message, stack: error.stack };
}

/**
 * Rebuilds an `Error` from a `SerializedError`. The result is always a
 * plain `Error` instance, never the original custom class: reconstructing
 * the exact class would need a class registry keyed by `name`, which the
 * engine does not keep. `name` and `stack` are still restored onto it, so
 * `instanceof` checks against `Error` and `error.name`/`error.stack`-based
 * handling both see the original error's identity.
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack !== undefined) {
    error.stack = serialized.stack;
  }
  return error;
}
