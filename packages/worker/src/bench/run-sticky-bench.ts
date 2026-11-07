import { DEFAULT_STICKY_BENCHMARK_CONFIG, runStickyBenchmark } from "./sticky-bench.js";

const enginesFlag = Number(process.env["BENCH_ENGINES"] ?? DEFAULT_STICKY_BENCHMARK_CONFIG.engines);
const runsFlag = Number(process.env["BENCH_RUNS"] ?? DEFAULT_STICKY_BENCHMARK_CONFIG.runs);
const sticky = process.env["BENCH_STICKY"] !== "off";

const result = await runStickyBenchmark({
  ...DEFAULT_STICKY_BENCHMARK_CONFIG,
  engines: enginesFlag,
  runs: runsFlag,
  stickyRouting: sticky,
});
process.stdout.write(
  [
    `| Setting | Value |`,
    `| --- | ---: |`,
    `| Engines | ${String(result.config.engines)} |`,
    `| Runs x steps | ${String(result.config.runs)} x ${String(result.config.stepsPerRun)} |`,
    `| Sticky routing | ${result.config.stickyRouting ? "on" : "off"} |`,
    `| Decisions | ${String(result.decisions)} |`,
    `| Decisions per engine | ${result.perEngineDecisions.join(", ")} |`,
    `| Resumed decisions | ${String(result.resumedDecisions)} |`,
    `| Cache hits | ${String(result.cacheHits)} |`,
    `| Sticky hit rate | ${(result.hitRate * 100).toFixed(1)} % |`,
    `| Elapsed (ms) | ${result.elapsedMs.toFixed(0)} |`,
    "",
  ].join("\n"),
);
