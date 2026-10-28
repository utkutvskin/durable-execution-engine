import { createHash } from "node:crypto";
import type { RandomSource } from "./sources.js";

const RANDOM_BYTES = 6;
const UUID_BYTES = 16;
const UUID_VERSION_4 = 0x40;
const UUID_VARIANT = 0x80;

function draw(seed: string, counter: number, bytes: number): Buffer {
  return createHash("sha256")
    .update(`${seed}:${String(counter)}`)
    .digest()
    .subarray(0, bytes);
}

/**
 * Creates the `RandomSource` a decision uses when it is not given one. Every
 * call takes the next value of a counter that starts at zero, and the value
 * is a function of `seed` and that counter alone, so a replay of the same
 * code over the same history draws the same numbers. The counter is shared
 * by `random` and `uuid`, so the nth value call of a run always yields the
 * same value whichever of the two it is.
 */
export function createSeededRandomSource(seed: string): RandomSource {
  let counter = 0;
  return {
    random(): number {
      const bytes = draw(seed, counter, RANDOM_BYTES);
      counter += 1;
      return bytes.readUIntBE(0, RANDOM_BYTES) / 2 ** (8 * RANDOM_BYTES);
    },
    uuid(): string {
      const bytes = draw(seed, counter, UUID_BYTES);
      counter += 1;
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | UUID_VERSION_4;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | UUID_VARIANT;
      const hex = bytes.toString("hex");
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
      ].join("-");
    },
  };
}
