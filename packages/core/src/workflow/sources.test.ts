import { describe, expect, it } from "vitest";
import { systemClock, systemRandomSource } from "./sources.js";

describe("systemClock", () => {
  it("returns the current wall-clock time", () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("systemRandomSource", () => {
  it("returns a number in [0, 1)", () => {
    const value = systemRandomSource.random();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });

  it("returns a well-formed uuid", () => {
    const value = systemRandomSource.uuid();
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
