import { jsonCodec } from "../event-store/codec.js";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

const UNDEFINED_ENCODING = "undefined";

/**
 * The canonical form of `value` as the event log stores it: the string the
 * default codec encodes, read back and encoded again with object keys in
 * sorted order. A live value (holding `undefined`, a `Date`, `NaN` or `-0`)
 * and the copy decoded from a stored event have the same encoding exactly
 * when the log would store them as the same payload. A value that encodes to
 * nothing (a bare `undefined`) has the encoding `"undefined"`.
 */
export function canonicalEncoding(value: unknown): string {
  const encoded = jsonCodec.encode(value) as string | undefined;
  if (encoded === undefined) {
    return UNDEFINED_ENCODING;
  }
  return jsonCodec.encode(sortKeys(jsonCodec.decode(encoded)));
}

/**
 * Whether `recorded` (read from the log) and `live` (produced by the code
 * being replayed) have the same canonical encoding.
 */
export function sameEncoding(recorded: unknown, live: unknown): boolean {
  return canonicalEncoding(recorded) === canonicalEncoding(live);
}
