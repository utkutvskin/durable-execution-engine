import type { LatencySummary } from "./stats.js";
import type { BenchmarkResult } from "./harness.js";

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function latencyRow(label: string, latency: LatencySummary): string {
  return `| ${label} | ${fixed(latency.p50Ms)} | ${fixed(latency.p95Ms)} | ${fixed(latency.p99Ms)} | ${fixed(latency.maxMs)} |`;
}

/**
 * Renders one benchmark result as markdown tables: the configuration, the
 * throughput of each phase and the latency percentiles.
 */
export function formatBenchmarkMarkdown(result: BenchmarkResult): string {
  const { config, start, endToEnd, append } = result;
  return [
    "| Setting | Value |",
    "| --- | ---: |",
    `| Runs | ${String(config.runs)} |`,
    `| Steps per run | ${String(config.stepsPerRun)} |`,
    `| Workers x concurrency | ${String(config.workers)} x ${String(config.workerConcurrency)} |`,
    `| Pool size | ${String(config.poolSize)} |`,
    `| Start concurrency | ${String(config.startConcurrency)} |`,
    `| Append batch size | ${String(config.appendBatchSize)} |`,
    "",
    "| Throughput | Count | Elapsed (ms) | Per second |",
    "| --- | ---: | ---: | ---: |",
    `| Runs started | ${String(start.runs)} | ${fixed(start.elapsedMs, 0)} | ${fixed(start.runsPerSecond)} |`,
    `| Runs completed end to end | ${String(endToEnd.runs)} | ${fixed(endToEnd.elapsedMs, 0)} | ${fixed(endToEnd.runsPerSecond)} |`,
    `| Steps completed | ${String(endToEnd.steps)} | ${fixed(endToEnd.elapsedMs, 0)} | ${fixed(endToEnd.stepsPerSecond)} |`,
    `| Events appended | ${String(append.events)} | ${fixed(append.elapsedMs, 0)} | ${fixed(append.eventsPerSecond)} |`,
    "",
    "| Latency (ms) | p50 | p95 | p99 | max |",
    "| --- | ---: | ---: | ---: | ---: |",
    latencyRow("Start a run", start.latency),
    latencyRow("Run end to end", endToEnd.latency),
    latencyRow(`Append ${String(config.appendBatchSize)} events`, append.latency),
  ].join("\n");
}
