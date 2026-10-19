import { performance } from "node:perf_hooks";
import {
  createPool,
  createPostgresEventStore,
  createResultRecorder,
  createTaskQueue,
  refreshProjection,
  type EventStore,
  type Pool,
  type TaskQueue,
} from "@dee/core";
import { createIsolatedDatabase } from "../../../core/src/db/test-harness.js";
import { createWorkerIdentity } from "../identity.js";
import { createWorker } from "../worker.js";
import { perSecond, summarizeLatencies, type LatencySummary } from "./stats.js";

/**
 * Knobs of one benchmark run. `runs` and `stepsPerRun` size the end-to-end
 * workload, `workers` times `workerConcurrency` is the number of tasks in
 * flight, `poolSize` is the connection pool shared by the starters and the
 * workers, and `appendBatchSize` is the number of events per append in the
 * append phase.
 */
export interface BenchmarkConfig {
  readonly runs: number;
  readonly stepsPerRun: number;
  readonly workers: number;
  readonly workerConcurrency: number;
  readonly poolSize: number;
  readonly startConcurrency: number;
  readonly appendBatchSize: number;
  readonly appendRuns: number;
  readonly appendRounds: number;
}

/**
 * The defaults used for the baseline in `docs/BENCHMARKS.md`.
 */
export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  runs: 400,
  stepsPerRun: 3,
  workers: 2,
  workerConcurrency: 8,
  poolSize: 20,
  startConcurrency: 16,
  appendBatchSize: 10,
  appendRuns: 16,
  appendRounds: 100,
};

/**
 * Throughput of a phase that only starts runs.
 */
export interface StartPhaseResult {
  readonly runs: number;
  readonly elapsedMs: number;
  readonly runsPerSecond: number;
  readonly latency: LatencySummary;
}

/**
 * Throughput and latency of the end-to-end phase: runs are started while
 * workers drain their step tasks, and a run's latency is the time from the
 * start call to its completion.
 */
export interface EndToEndPhaseResult {
  readonly runs: number;
  readonly steps: number;
  readonly elapsedMs: number;
  readonly runsPerSecond: number;
  readonly stepsPerSecond: number;
  readonly latency: LatencySummary;
}

/**
 * Throughput of the phase that appends batches of events to many runs.
 */
export interface AppendPhaseResult {
  readonly events: number;
  readonly batches: number;
  readonly elapsedMs: number;
  readonly eventsPerSecond: number;
  readonly latency: LatencySummary;
}

/**
 * Everything one benchmark run measured.
 */
export interface BenchmarkResult {
  readonly config: BenchmarkConfig;
  readonly start: StartPhaseResult;
  readonly endToEnd: EndToEndPhaseResult;
  readonly append: AppendPhaseResult;
}

interface BenchContext {
  readonly pool: Pool;
  readonly store: EventStore;
  readonly queue: TaskQueue;
  readonly namespaceId: string;
}

const START_QUEUE = "bench-start";
const WORK_QUEUE = "bench-work";

async function createRunRow(context: BenchContext): Promise<string> {
  const run = await context.pool.query<{ id: string }>(
    "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'bench') returning id",
    [context.namespaceId],
  );
  return run.rows[0]?.id ?? "";
}

async function startRun(
  context: BenchContext,
  queueName: string,
  stepsPerRun: number,
  onCreated?: (runId: string) => void,
): Promise<string> {
  const runId = await createRunRow(context);
  onCreated?.(runId);
  await context.store.append(runId, 0, [
    { type: "run_started", workflowType: "bench", input: { steps: stepsPerRun } },
    ...Array.from({ length: stepsPerRun }, (_, index) => ({
      type: "step_scheduled" as const,
      stepId: `step-${String(index + 1)}`,
      stepType: "bench",
      input: { index },
    })),
  ]);
  await context.queue.enqueue({
    namespaceId: context.namespaceId,
    runId,
    queueName,
    taskType: "STEP_TASK",
    payload: { steps: stepsPerRun },
  });
  return runId;
}

async function runPool<T>(
  total: number,
  concurrency: number,
  work: (index: number) => Promise<T>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (next < total) {
      const index = next;
      next += 1;
      await work(index);
    }
  });
  await Promise.all(lanes);
}

async function measureStartPhase(
  context: BenchContext,
  config: BenchmarkConfig,
): Promise<StartPhaseResult> {
  const latencies: number[] = [];
  const began = performance.now();
  await runPool(config.runs, config.startConcurrency, async () => {
    const submitted = performance.now();
    await startRun(context, START_QUEUE, config.stepsPerRun);
    latencies.push(performance.now() - submitted);
  });
  const elapsedMs = performance.now() - began;
  return {
    runs: config.runs,
    elapsedMs,
    runsPerSecond: perSecond(config.runs, elapsedMs),
    latency: summarizeLatencies(latencies),
  };
}

async function measureEndToEnd(
  context: BenchContext,
  config: BenchmarkConfig,
): Promise<EndToEndPhaseResult> {
  const recorder = createResultRecorder(context.pool);
  const submittedAt = new Map<string, number>();
  const latencies: number[] = [];
  let finished = 0;
  let signalDone: () => void = () => undefined;
  const allDone = new Promise<void>((resolve) => {
    signalDone = resolve;
  });

  const workers = Array.from({ length: config.workers }, (_, index) =>
    createWorker({
      queue: createTaskQueue(context.pool),
      queueName: WORK_QUEUE,
      concurrency: config.workerConcurrency,
      pollIntervalMs: 2,
      maxPollIntervalMs: 10,
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
      shutdownTimeoutMs: 5_000,
      identity: createWorkerIdentity({ version: `bench-${String(index)}` }),
      handler: async (task) => {
        const payload = task.payload as { steps: number };
        for (let step = 1; step <= payload.steps; step += 1) {
          await recorder.recordStepResult({
            runId: task.runId,
            stepId: `step-${String(step)}`,
            attemptKey: `step-${String(step)}#1`,
            outcome: { status: "completed", result: step },
          });
        }
        const history = await context.store.read(task.runId);
        await recorder.recordWorkflowTaskResult({
          runId: task.runId,
          taskKey: "finish",
          expectedSeq: history.at(-1)?.sequenceNumber ?? 0,
          events: [{ type: "run_completed", result: payload.steps }],
        });
        await refreshProjection(context.pool, context.store, task.runId);
        const submitted = submittedAt.get(task.runId);
        if (submitted !== undefined) {
          latencies.push(performance.now() - submitted);
        }
        finished += 1;
        if (finished === config.runs) {
          signalDone();
        }
      },
    }),
  );

  const began = performance.now();
  workers.forEach((worker) => {
    worker.start();
  });
  await runPool(config.runs, config.startConcurrency, async () => {
    const submitted = performance.now();
    await startRun(context, WORK_QUEUE, config.stepsPerRun, (runId) => {
      submittedAt.set(runId, submitted);
    });
  });
  await allDone;
  const elapsedMs = performance.now() - began;
  await Promise.all(workers.map((worker) => worker.stop()));
  const steps = config.runs * config.stepsPerRun;
  return {
    runs: config.runs,
    steps,
    elapsedMs,
    runsPerSecond: perSecond(config.runs, elapsedMs),
    stepsPerSecond: perSecond(steps, elapsedMs),
    latency: summarizeLatencies(latencies),
  };
}

async function measureAppendPhase(
  context: BenchContext,
  config: BenchmarkConfig,
): Promise<AppendPhaseResult> {
  const runIds = await Promise.all(
    Array.from({ length: config.appendRuns }, () => createRunRow(context)),
  );
  const latencies: number[] = [];
  const began = performance.now();
  await Promise.all(
    runIds.map(async (runId) => {
      let sequence = 0;
      for (let round = 0; round < config.appendRounds; round += 1) {
        const batch = Array.from({ length: config.appendBatchSize }, (_, index) => ({
          type: "signal_received" as const,
          signalName: "tick",
          payload: { round, index },
        }));
        const submitted = performance.now();
        await context.store.append(runId, sequence, batch);
        latencies.push(performance.now() - submitted);
        sequence += batch.length;
      }
    }),
  );
  const elapsedMs = performance.now() - began;
  const events = config.appendRuns * config.appendRounds * config.appendBatchSize;
  return {
    events,
    batches: config.appendRuns * config.appendRounds,
    elapsedMs,
    eventsPerSecond: perSecond(events, elapsedMs),
    latency: summarizeLatencies(latencies),
  };
}

/**
 * Runs the three benchmark phases (start rate, end-to-end latency and append
 * throughput) against a fresh, migrated schema on the database that
 * `DATABASE_URL` points at, and drops the schema afterwards.
 */
export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  const database = await createIsolatedDatabase();
  const pool = createPool(process.env, { schema: database.schema, max: config.poolSize });
  try {
    const namespace = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('bench') returning id",
    );
    const context: BenchContext = {
      pool,
      store: createPostgresEventStore(pool),
      queue: createTaskQueue(pool),
      namespaceId: namespace.rows[0]?.id ?? "",
    };
    const start = await measureStartPhase(context, config);
    const endToEnd = await measureEndToEnd(context, config);
    const append = await measureAppendPhase(context, config);
    return { config, start, endToEnd, append };
  } finally {
    await pool.end();
    await database.close();
  }
}
