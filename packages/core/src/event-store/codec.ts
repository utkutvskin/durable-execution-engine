/**
 * Converts a validated event to and from the string form stored in
 * `run_events.payload`. `jsonCodec` is v0's implementation; a later day can
 * hang a compression or masking step off this same seam without changing
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
