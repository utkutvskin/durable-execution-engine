import { PayloadTooLargeError } from "./errors.js";

/**
 * Converts a validated event to and from the string form stored in
 * `run_events.payload`. `createJsonCodec` is v0's implementation; a
 * compression or masking step hangs off its own options rather than
 * changing this interface, so `EventStore` never has to know which of them
 * are in use.
 */
export interface Codec {
  encode(value: unknown): string;
  decode(raw: string): unknown;
}

/**
 * Configures `createJsonCodec`. Every option is a hook: leaving it out
 * reproduces plain, uncompressed, unmasked JSON, exactly `jsonCodec`'s
 * behavior.
 */
export interface CodecOptions {
  /**
   * The largest number of bytes `encode` will hand back. Checked on the
   * final wire string, after masking and compression, since that is what
   * actually reaches the `payload` column. Defaults to 1 MiB (1,048,576
   * bytes).
   */
  readonly maxPayloadBytes?: number;
  /** Runs on the JSON string before it is measured and returned. */
  readonly compress?: (json: string) => string;
  /** Undoes `compress`, run on `decode` before `JSON.parse`. */
  readonly decompress?: (wire: string) => string;
  /**
   * Object key names whose value is replaced with a fixed redaction marker
   * everywhere it appears in the encoded value, at any depth. Applied
   * before `compress`, so a masked field is never present in the stored
   * payload at all: this is redaction of data at rest, not just of a
   * printed or logged view of it, which is why masking a field also means
   * a replayed workflow can never see its original value again.
   */
  readonly sensitiveFields?: readonly string[];
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;
const REDACTED = "[redacted]";

function maskSensitiveFields(value: unknown, fieldNames: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveFields(item, fieldNames));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        fieldNames.has(key) ? REDACTED : maskSensitiveFields(entryValue, fieldNames),
      ]),
    );
  }
  return value;
}

/**
 * Creates a `Codec` around plain JSON, with three optional hooks layered on
 * top: sensitive-field masking (applied to the value before it is
 * stringified), compression (applied to the JSON string), and a payload
 * size limit (checked on the final string, throwing `PayloadTooLargeError`
 * when it is exceeded). `jsonCodec` is `createJsonCodec()` with every hook
 * left at its default.
 */
export function createJsonCodec(options: CodecOptions = {}): Codec {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const sensitiveFields = new Set(options.sensitiveFields ?? []);

  return {
    encode(value: unknown): string {
      const maskable =
        sensitiveFields.size > 0 ? maskSensitiveFields(value, sensitiveFields) : value;
      const json = JSON.stringify(maskable);
      const wire = options.compress === undefined ? json : options.compress(json);

      const byteLength = Buffer.byteLength(wire, "utf8");
      if (byteLength > maxPayloadBytes) {
        throw new PayloadTooLargeError(byteLength, maxPayloadBytes);
      }

      return wire;
    },
    decode(raw: string): unknown {
      const json = options.decompress === undefined ? raw : options.decompress(raw);
      return JSON.parse(json) as unknown;
    },
  };
}

/**
 * The default `Codec`: plain JSON, no compression or masking, a 1 MiB
 * payload limit.
 */
export const jsonCodec: Codec = createJsonCodec();
