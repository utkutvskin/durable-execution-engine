import type { ClockSource } from "../workflow/sources.js";

/**
 * A `ClockSource` that never goes backwards. `regressions` counts the
 * readings of the underlying clock that were earlier than one already
 * served.
 */
export interface MonotonicClock extends ClockSource {
  readonly regressions: number;
  readonly lastReading: Date | undefined;
}

/**
 * Wraps `source` so that every reading is at least as late as the previous
 * one. When the wall clock is stepped back (an NTP correction, a manual
 * change), the wrapper keeps serving the latest time it has seen until the
 * source catches up, so a scheduler's decisions about what is due never
 * reverse. Forward jumps pass through untouched.
 */
export function createMonotonicClock(source: ClockSource): MonotonicClock {
  let highWater: Date | undefined;
  let regressions = 0;

  return {
    now(): Date {
      const reading = source.now();
      if (highWater !== undefined && reading.getTime() < highWater.getTime()) {
        regressions += 1;
        return new Date(highWater.getTime());
      }
      highWater = new Date(reading.getTime());
      return new Date(reading.getTime());
    },
    get regressions(): number {
      return regressions;
    },
    get lastReading(): Date | undefined {
      return highWater === undefined ? undefined : new Date(highWater.getTime());
    },
  };
}
