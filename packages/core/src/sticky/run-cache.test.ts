import { describe, expect, it } from "vitest";
import { createRunCache } from "./run-cache.js";

function fakeClock(): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse("2026-01-01T00:00:00.000Z");
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("run cache", () => {
  it("returns what was stored and counts hits and misses", () => {
    const cache = createRunCache<string>({ maxRuns: 2, stickyTimeoutMs: 1000, clock: fakeClock() });
    cache.set("run-1", "a");
    expect(cache.get("run-1")).toBe("a");
    expect(cache.get("run-2")).toBeUndefined();
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, evictions: 0, expirations: 0 });
  });

  it("evicts the least recently used run when it is full", () => {
    const cache = createRunCache<string>({ maxRuns: 2, stickyTimeoutMs: 1000, clock: fakeClock() });
    cache.set("run-1", "a");
    cache.set("run-2", "b");
    cache.get("run-1");
    cache.set("run-3", "c");
    expect(cache.get("run-2")).toBeUndefined();
    expect(cache.get("run-1")).toBe("a");
    expect(cache.get("run-3")).toBe("c");
    expect(cache.stats().evictions).toBe(1);
    expect(cache.size).toBe(2);
  });

  it("drops an entry idle for longer than the sticky timeout", () => {
    const clock = fakeClock();
    const cache = createRunCache<string>({ maxRuns: 4, stickyTimeoutMs: 1000, clock });
    cache.set("run-1", "a");
    clock.advance(1000);
    expect(cache.get("run-1")).toBe("a");
    clock.advance(1001);
    expect(cache.get("run-1")).toBeUndefined();
    expect(cache.stats().expirations).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("refreshes the idle timer on every get", () => {
    const clock = fakeClock();
    const cache = createRunCache<string>({ maxRuns: 4, stickyTimeoutMs: 1000, clock });
    cache.set("run-1", "a");
    for (let round = 0; round < 5; round += 1) {
      clock.advance(800);
      expect(cache.get("run-1")).toBe("a");
    }
  });

  it("deletes and clears entries", () => {
    const cache = createRunCache<string>({ maxRuns: 4, stickyTimeoutMs: 1000, clock: fakeClock() });
    cache.set("run-1", "a");
    cache.set("run-2", "b");
    expect(cache.delete("run-1")).toBe(true);
    expect(cache.delete("run-1")).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("rejects limits that are not positive integers", () => {
    expect(() => createRunCache({ maxRuns: 0, stickyTimeoutMs: 1000 })).toThrow(RangeError);
    expect(() => createRunCache({ maxRuns: 1, stickyTimeoutMs: 0 })).toThrow(RangeError);
  });
});
