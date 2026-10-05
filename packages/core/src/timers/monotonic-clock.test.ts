import { describe, expect, it } from "vitest";
import { createMonotonicClock } from "./monotonic-clock.js";

function steppedClock(times: readonly string[]) {
  let index = 0;
  return { now: () => new Date(times[index++] ?? times[times.length - 1] ?? "") };
}

describe("monotonic clock", () => {
  it("passes forward readings through unchanged", () => {
    const clock = createMonotonicClock(
      steppedClock(["2026-03-01T10:00:00.000Z", "2026-03-01T10:05:00.000Z"]),
    );
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-03-01T10:05:00.000Z");
    expect(clock.regressions).toBe(0);
  });

  it("holds the latest reading when the source steps backwards and counts the regression", () => {
    const clock = createMonotonicClock(
      steppedClock(["2026-03-01T10:00:00.000Z", "2026-03-01T09:00:00.000Z"]),
    );
    clock.now();
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(clock.regressions).toBe(1);
  });

  it("resumes following the source once it passes the high water mark again", () => {
    const clock = createMonotonicClock(
      steppedClock([
        "2026-03-01T10:00:00.000Z",
        "2026-03-01T09:00:00.000Z",
        "2026-03-01T10:00:00.001Z",
      ]),
    );
    clock.now();
    clock.now();
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.001Z");
    expect(clock.lastReading?.toISOString()).toBe("2026-03-01T10:00:00.001Z");
  });

  it("returns a copy, so a caller cannot move the high water mark", () => {
    const clock = createMonotonicClock(steppedClock(["2026-03-01T10:00:00.000Z"]));
    clock.now().setFullYear(2099);
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.000Z");
  });
});
