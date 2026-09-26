import { gunzipSync, gzipSync } from "node:zlib";
import { PayloadTooLargeError } from "./errors.js";

/**
 * Converts a validated event to and from the string form stored in
 * `run_events.payload`. `jsonCodec` is v0's implementation; `createGzipCodec`
 * and `createSizeLimitedCodec` hang a compression step and a payload limit
 * off this same seam, by wrapping another `Codec` rather than changing
 * `EventStore` itself.
 */
export interface Codec {
  encode(value: unknown): string;
  decode(raw: string): unknown;
}

/**
 * The default `Codec`: plain JSON, no compression or masking.
 */
export const jsonCodec: Codec = {
  encode(value: unknown): string {
    return JSON.stringify(value);
  },
  decode(raw: string): unknown {
    return JSON.parse(raw) as unknown;
  },
};

/**
 * The default limit `createSizeLimitedCodec` enforces when none is given:
 * 1 MiB (1,048,576 bytes) of encoded payload.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;

/**
 * Wraps `codec` so that `encode` rejects with `PayloadTooLargeError` once
 * the encoded string exceeds `maxBytes` (measured as UTF-8 bytes, since
 * that is what actually gets stored), instead of handing an oversized
 * payload to the event store. `decode` is unaffected: a payload already in
 * the log was accepted under whatever limit was in force when it was
 * written, and reading it back is never rejected retroactively.
 */
export function createSizeLimitedCodec(
  codec: Codec,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES,
): Codec {
  return {
    encode(value: unknown): string {
      const encoded = codec.encode(value);
      const actualBytes = Buffer.byteLength(encoded, "utf8");
      if (actualBytes > maxBytes) {
        throw new PayloadTooLargeError(actualBytes, maxBytes);
      }
      return encoded;
    },
    decode(raw: string): unknown {
      return codec.decode(raw);
    },
  };
}

/**
 * Wraps `codec` so that `encode` gzip-compresses its output (base64-encoded,
 * since `Codec.encode` returns a string) and `decode` reverses both steps
 * before delegating back to `codec`. Round-trips losslessly; whether it is
 * worth composing with `createSizeLimitedCodec` for a given workload
 * depends on how compressible that workload's payloads actually are.
 */
export function createGzipCodec(codec: Codec): Codec {
  return {
    encode(value: unknown): string {
      const encoded = codec.encode(value);
      return gzipSync(Buffer.from(encoded, "utf8")).toString("base64");
    },
    decode(raw: string): unknown {
      const decoded = gunzipSync(Buffer.from(raw, "base64")).toString("utf8");
      return codec.decode(decoded);
    },
  };
}

function maskValue(value: unknown, sensitiveKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => maskValue(entry, sensitiveKeys));
  }
  if (value !== null && typeof value === "object") {
    const masked: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      masked[key] = sensitiveKeys.has(key) ? "[masked]" : maskValue(entryValue, sensitiveKeys);
    }
    return masked;
  }
  return value;
}

/**
 * Returns a deep copy of `value` with every object key in `sensitiveFields`
 * (matched at any depth) replaced by the literal string `"[masked]"`. For
 * diagnostics and display only — the event store's own `encode`/`decode`
 * round trip never calls this, since durable replay needs the real value
 * a step or workflow actually saw, not a redacted one.
 */
export function maskSensitiveFields(value: unknown, sensitiveFields: readonly string[]): unknown {
  return maskValue(value, new Set(sensitiveFields));
}
