import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./token-bucket.js";

function movableClock(): { now(): Date; advance(ms: number): void } {
  let elapsed = 0;
  const start = new Date("2026-03-01T12:00:00.000Z").getTime();
  return {
    now: () => new Date(start + elapsed),
    advance(ms: number): void {
      elapsed += ms;
    },
  };
}

describe("token bucket rate limiter", () => {
  const config = { ratePerSecond: 2, burst: 3 };

  it("lets a full burst through and then refuses with the wait for one token", () => {
    const limiter = createRateLimiter({ clock: movableClock() });
    const decisions = Array.from({ length: 4 }, () => limiter.take("a", config));
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    expect(decisions[3]?.retryAfterMs).toBe(500);
  });

  it("refills at the configured rate and never beyond the burst", () => {
    const clock = movableClock();
    const limiter = createRateLimiter({ clock });
    for (let index = 0; index < 3; index += 1) {
      limiter.take("a", config);
    }
    clock.advance(499);
    expect(limiter.take("a", config).allowed).toBe(false);
    clock.advance(1);
    expect(limiter.take("a", config).allowed).toBe(true);
    clock.advance(3_600_000);
    const afterLongPause = Array.from({ length: 4 }, () => limiter.take("a", config));
    expect(afterLongPause.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
  });

  it("keeps the buckets of different keys apart", () => {
    const limiter = createRateLimiter({ clock: movableClock() });
    for (let index = 0; index < 3; index += 1) {
      limiter.take("noisy", config);
    }
    expect(limiter.take("noisy", config).allowed).toBe(false);
    expect(limiter.take("quiet", config).allowed).toBe(true);
  });

  it("holds the long run rate over a simulated minute", () => {
    const clock = movableClock();
    const limiter = createRateLimiter({ clock });
    let allowed = 0;
    for (let tick = 0; tick < 60_000; tick += 10) {
      if (limiter.take("a", config).allowed) {
        allowed += 1;
      }
      clock.advance(10);
    }
    expect(allowed).toBeGreaterThanOrEqual(120);
    expect(allowed).toBeLessThanOrEqual(123);
  });

  it("does not refill when the clock steps backwards", () => {
    const clock = movableClock();
    const limiter = createRateLimiter({ clock });
    for (let index = 0; index < 3; index += 1) {
      limiter.take("a", config);
    }
    clock.advance(-10_000);
    expect(limiter.take("a", config).allowed).toBe(false);
  });

  it("reports the remaining tokens and rejects an invalid configuration", () => {
    const limiter = createRateLimiter({ clock: movableClock() });
    expect(limiter.take("a", config).remaining).toBe(2);
    limiter.reset("a");
    expect(limiter.take("a", config).remaining).toBe(2);
    expect(() => limiter.take("a", { ratePerSecond: 0, burst: 1 })).toThrow(RangeError);
    expect(() => limiter.take("a", { ratePerSecond: 1, burst: 1.5 })).toThrow(RangeError);
  });
});
