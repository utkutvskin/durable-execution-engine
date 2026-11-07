import { describe, expect, it } from "vitest";
import { DEFAULT_STICKY_BENCHMARK_CONFIG, runStickyBenchmark } from "./sticky-bench.js";

describe("sticky routing benchmark", () => {
  it("serves more than 80 percent of the resumed decisions from the cache with 3 engines", async () => {
    const result = await runStickyBenchmark({ ...DEFAULT_STICKY_BENCHMARK_CONFIG, runs: 40 });
    expect(result.resumedDecisions).toBe(40 * 4);
    expect(result.hitRate).toBeGreaterThan(0.8);
  }, 90_000);

  it("shares the decisions between all 3 engines", async () => {
    const result = await runStickyBenchmark({ ...DEFAULT_STICKY_BENCHMARK_CONFIG, runs: 40 });
    expect(result.perEngineDecisions).toHaveLength(3);
    expect(result.perEngineDecisions.every((count) => count > 0)).toBe(true);
  }, 90_000);

  it("hits the cache clearly less often when sticky routing is off", async () => {
    const result = await runStickyBenchmark({
      ...DEFAULT_STICKY_BENCHMARK_CONFIG,
      runs: 40,
      stickyRouting: false,
    });
    expect(result.hitRate).toBeLessThan(0.85);
  }, 90_000);
});
