import type { ApiClient } from "./api.js";

const ENVELOPE_KEY = "$dee_codec";

/**
 * Whether `value` holds a payload encoded by the server's codec, at any
 * depth: such a value is shown only after the codec endpoint decoded it.
 */
export function containsEncodedPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsEncodedPayload);
  }
  if (value !== null && typeof value === "object") {
    if (typeof (value as Record<string, unknown>)[ENVELOPE_KEY] === "string") {
      return true;
    }
    return Object.values(value).some(containsEncodedPayload);
  }
  return false;
}

/**
 * What the UI shows instead of a payload the codec endpoint could not
 * decode.
 */
export const UNDECODABLE_PAYLOAD = "[encoded payload: the codec endpoint could not decode it]";

/**
 * Returns `values` ready to show: when one holds an encoded payload, all of
 * them go through the codec endpoint in one request (which also masks the
 * fields the server is told to mask); otherwise they are shown as they are.
 * If the endpoint refuses, every encoded value is replaced by
 * `UNDECODABLE_PAYLOAD` and the ciphertext is never shown.
 */
export async function decodeForDisplay(
  api: Pick<ApiClient, "decodePayloads">,
  values: readonly unknown[],
): Promise<unknown[]> {
  if (!values.some(containsEncodedPayload)) {
    return [...values];
  }
  try {
    return await api.decodePayloads(values);
  } catch {
    return values.map((value) => (containsEncodedPayload(value) ? UNDECODABLE_PAYLOAD : value));
  }
}
