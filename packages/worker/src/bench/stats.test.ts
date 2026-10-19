import { describe, expect, it } from "vitest";
import { percentile, perSecond, summarizeLatencies } from "./stats.js";

describe("percentile", () => {
  const sample = Array.from({ length: 100 }, (_, index) => index + 1);

  it("uses the nearest rank", () => {
    expect(percentile(sample, 0.5)).toBe(50);
    expect(percentile(sample, 0.95)).toBe(95);
    expect(percentile(sample, 0.99)).toBe(99);
  });

  it("returns the smallest value at 0 and the largest at 1", () => {
    expect(percentile(sample, 0)).toBe(1);
    expect(percentile(sample, 1)).toBe(100);
  });

  it("returns the only value of a one element sample for every fraction", () => {
    expect(percentile([7], 0.01)).toBe(7);
    expect(percentile([7], 0.99)).toBe(7);
  });

  it("rejects an empty sample and a fraction outside 0 to 1", () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
    expect(() => percentile(sample, 1.1)).toThrow(RangeError);
    expect(() => percentile(sample, -0.1)).toThrow(RangeError);
  });
});

describe("summarizeLatencies", () => {
  it("sorts an unsorted sample without modifying it", () => {
    const samples = [30, 10, 20];
    const summary = summarizeLatencies(samples);
    expect(samples).toEqual([30, 10, 20]);
    expect(summary).toMatchObject({ count: 3, minMs: 10, maxMs: 30, p50Ms: 20, meanMs: 20 });
  });

  it("reports p99 at the tail of a skewed sample", () => {
    const samples = [...Array.from({ length: 99 }, () => 1), 1000];
    const summary = summarizeLatencies(samples);
    expect(summary.p50Ms).toBe(1);
    expect(summary.p95Ms).toBe(1);
    expect(summary.p99Ms).toBe(1);
    expect(summary.maxMs).toBe(1000);
  });
});

describe("perSecond", () => {
  it("scales a count over milliseconds to a rate per second", () => {
    expect(perSecond(500, 250)).toBe(2000);
  });

  it("rejects a non-positive duration", () => {
    expect(() => perSecond(1, 0)).toThrow(RangeError);
  });
});
