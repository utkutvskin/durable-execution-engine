import { describe, expect, it } from "vitest";
import { formatBenchmarkMarkdown } from "./format.js";
import { DEFAULT_BENCHMARK_CONFIG, runBenchmark, type BenchmarkConfig } from "./harness.js";

const SMALL: BenchmarkConfig = {
  ...DEFAULT_BENCHMARK_CONFIG,
  runs: 12,
  stepsPerRun: 2,
  workers: 1,
  workerConcurrency: 4,
  poolSize: 8,
  startConcurrency: 4,
  appendRuns: 3,
  appendRounds: 4,
  appendBatchSize: 5,
};

describe("runBenchmark", () => {
  it("starts, completes and appends exactly the configured amounts", async () => {
    const result = await runBenchmark(SMALL);
    expect(result.start.runs).toBe(12);
    expect(result.start.latency.count).toBe(12);
    expect(result.endToEnd.runs).toBe(12);
    expect(result.endToEnd.steps).toBe(24);
    expect(result.endToEnd.latency.count).toBe(12);
    expect(result.append.events).toBe(60);
    expect(result.append.batches).toBe(12);
    expect(result.append.latency.count).toBe(12);
  });

  it("reports positive rates and ordered percentiles", async () => {
    const result = await runBenchmark(SMALL);
    expect(result.start.runsPerSecond).toBeGreaterThan(0);
    expect(result.endToEnd.stepsPerSecond).toBeGreaterThan(0);
    expect(result.append.eventsPerSecond).toBeGreaterThan(0);
    const { latency } = result.endToEnd;
    expect(latency.p50Ms).toBeLessThanOrEqual(latency.p95Ms);
    expect(latency.p95Ms).toBeLessThanOrEqual(latency.p99Ms);
    expect(latency.p99Ms).toBeLessThanOrEqual(latency.maxMs);
  });

  it("renders every phase into the markdown tables", async () => {
    const markdown = formatBenchmarkMarkdown(await runBenchmark(SMALL));
    expect(markdown).toContain("| Runs started | 12 |");
    expect(markdown).toContain("| Steps completed | 24 |");
    expect(markdown).toContain("| Events appended | 60 |");
    expect(markdown).toContain("| Run end to end |");
    expect(markdown).toContain("| Append 5 events |");
  });
});
