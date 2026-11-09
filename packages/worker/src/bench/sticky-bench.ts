import { defineStep, defineWorkflow, type Pool } from "@dee/core";
import { createRunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase } from "../../../core/src/db/test-harness.ts";
import { startEngine, type Engine } from "../engine/runtime.ts";

/**
 * Knobs of `runStickyBenchmark`: how many `engines` (worker processes in one
 * test process) share the database, how many `runs` of `stepsPerRun` steps
 * they decide, and whether they use sticky routing.
 */
export interface StickyBenchmarkConfig {
  readonly engines: number;
  readonly runs: number;
  readonly stepsPerRun: number;
  readonly concurrency: number;
  readonly stickyRouting: boolean;
  readonly timeoutMs: number;
}

/**
 * The defaults of `pnpm run bench:sticky`: 3 engines.
 */
export const DEFAULT_STICKY_BENCHMARK_CONFIG: StickyBenchmarkConfig = {
  engines: 3,
  runs: 60,
  stepsPerRun: 4,
  concurrency: 4,
  stickyRouting: true,
  timeoutMs: 60_000,
};

/**
 * What a sticky benchmark measured. `resumedDecisions` are the decisions that
 * could have used a cached session (every decision except the first of a
 * run); `hitRate` is the share of them that did.
 */
export interface StickyBenchmarkResult {
  readonly config: StickyBenchmarkConfig;
  readonly decisions: number;
  readonly resumedDecisions: number;
  readonly cacheHits: number;
  readonly hitRate: number;
  readonly perEngineDecisions: readonly number[];
  readonly elapsedMs: number;
}

const WORKFLOW_TYPE = "sticky-bench";

async function completedRuns(pool: Pool): Promise<number> {
  const result = await pool.query<{ done: string }>(
    "select count(*) as done from workflow_runs where status <> 'RUNNING'",
  );
  return Number(result.rows[0]?.done ?? 0);
}

/**
 * Starts `config.engines` engines against one fresh database, runs
 * `config.runs` workflows of `config.stepsPerRun` sequential steps through
 * them and reports how often a decision advanced a cached session.
 */
export async function runStickyBenchmark(
  config: StickyBenchmarkConfig = DEFAULT_STICKY_BENCHMARK_CONFIG,
): Promise<StickyBenchmarkResult> {
  const database = await createIsolatedDatabase();
  const engines: Engine[] = [];
  try {
    const pool = database.pool;
    const namespace = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('bench') returning id",
    );
    const namespaceId = namespace.rows[0]?.id ?? "";
    const step = defineStep<{ n: number }, number>("bench-step", { handler: ({ n }) => n + 1 });
    const workflow = defineWorkflow(WORKFLOW_TYPE, async (ctx) => {
      let value = 0;
      for (let index = 0; index < config.stepsPerRun; index += 1) {
        value = await ctx.step<number>("bench-step", { n: value });
      }
      return value;
    });
    const service = createRunService(pool, { queueName: "default" });
    const started = performance.now();
    for (let index = 0; index < config.engines; index += 1) {
      engines.push(
        startEngine({
          pool,
          workflows: [workflow],
          steps: [step],
          concurrency: config.concurrency,
          pollIntervalMs: 10,
          loopIntervalMs: 200,
          stickyRouting: config.stickyRouting,
        }),
      );
    }
    for (let index = 0; index < config.runs; index += 1) {
      await service.startRun(namespaceId, { workflowType: WORKFLOW_TYPE });
    }
    const deadline = Date.now() + config.timeoutMs;
    while ((await completedRuns(pool)) < config.runs) {
      if (Date.now() > deadline) {
        throw new Error("the benchmark runs did not finish in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const elapsedMs = performance.now() - started;
    const totals = engines.map((engine) => engine.decisionTotals());
    const cacheHits = totals.reduce((sum, entry) => sum + entry.cache, 0);
    const decisions = totals.reduce((sum, entry) => sum + entry.cache + entry.replay, 0);
    const resumedDecisions = decisions - config.runs;
    return {
      config,
      decisions,
      resumedDecisions,
      cacheHits,
      hitRate: resumedDecisions > 0 ? cacheHits / resumedDecisions : 0,
      perEngineDecisions: totals.map((entry) => entry.cache + entry.replay),
      elapsedMs,
    };
  } finally {
    await Promise.all(engines.map((engine) => engine.stop()));
    await database.close();
  }
}
