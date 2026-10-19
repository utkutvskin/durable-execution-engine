import { DEFAULT_BENCHMARK_CONFIG, runBenchmark, type BenchmarkConfig } from "./harness.js";
import { formatBenchmarkMarkdown } from "./format.js";

const NUMERIC_KEYS = [
  "runs",
  "stepsPerRun",
  "workers",
  "workerConcurrency",
  "poolSize",
  "startConcurrency",
  "appendBatchSize",
  "appendRuns",
  "appendRounds",
] as const satisfies readonly (keyof BenchmarkConfig)[];

function readConfig(env: NodeJS.ProcessEnv): BenchmarkConfig {
  const overrides: Partial<Record<keyof BenchmarkConfig, number>> = {};
  for (const key of NUMERIC_KEYS) {
    const raw = env[`BENCH_${key.replaceAll(/([A-Z])/g, "_$1").toUpperCase()}`];
    if (raw !== undefined) {
      overrides[key] = Number(raw);
    }
  }
  return { ...DEFAULT_BENCHMARK_CONFIG, ...overrides };
}

const result = await runBenchmark(readConfig(process.env));
process.stdout.write(`${formatBenchmarkMarkdown(result)}\n`);
