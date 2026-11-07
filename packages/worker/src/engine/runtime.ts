import {
  createEngineMetrics,
  createHistoryCompactor,
  createJanitor,
  createStickyRouter,
  createScheduleManager,
  createTaskQueue,
  createTimerScheduler,
  systemClock,
  type ClockSource,
  type EngineMetrics,
  type Pool,
  type RandomSource,
  type RecoveryMetrics,
  type RetentionPolicy,
  type ScheduleManager,
  type Tracing,
} from "@dee/core";
import { startCompactorLoop, type CompactorLoop } from "../compactor-loop.js";
import { createWorkerIdentity } from "../identity.js";
import { startJanitorLoop, type JanitorLoop } from "../janitor-loop.js";
import { startScheduleLoop, type ScheduleLoop } from "../schedule-loop.js";
import { startTimerLoop, type TimerLoop } from "../timer-loop.js";
import { createWorker, type NackBackoff, type StopResult, type Worker } from "../worker.js";
import {
  createEngineTaskHandler,
  type AnyStepDefinition,
  type AnyWorkflowDefinition,
  type DecisionReport,
} from "./task-handler.js";

/**
 * Configuration of `startEngine`. The loops run every `loopIntervalMs`
 * (default 1000); the janitor reclaims leases and recovers runs that made no
 * progress for `stalledRunGraceMs` (default 60000). A task whose handler
 * fails is redelivered after `nackBackoff` (default 250 ms doubling up to
 * 30 s, from `task.attempts`) and quarantined after `maxHandlerAttempts`
 * failed deliveries (default 8) or `poisonThreshold` lost leases (default 3).
 * `onError` receives every error the engine survives.
 *
 * `stickyRouting` (default true) makes the engine claim each open run it
 * decides and leave the workflow tasks of runs another live worker has
 * claimed to that worker, so decisions advance a cached session instead of
 * replaying the history. `compaction` adds a loop that compacts closed runs
 * every `intervalMs` under `policy` (`batchSize` runs per sweep).
 * `engine.metrics` renders the eight engine metrics: task latency is filled
 * from the worker and the reclaimed lease count from the janitor of this
 * engine.
 */
export interface EngineOptions {
  readonly pool: Pool;
  readonly queueName?: string;
  readonly workflows: readonly AnyWorkflowDefinition[];
  readonly steps: readonly AnyStepDefinition[];
  readonly buildId?: string;
  readonly maxCachedRuns?: number;
  readonly stickyTimeoutMs?: number;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly visibilityTimeoutMs?: number;
  readonly loopIntervalMs?: number;
  readonly stalledRunGraceMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly nackBackoff?: NackBackoff;
  readonly maxHandlerAttempts?: number;
  readonly poisonThreshold?: number;
  readonly stickyRouting?: boolean;
  readonly compaction?: CompactionOptions;
  readonly clock?: ClockSource;
  readonly random?: RandomSource;
  readonly tracing?: Tracing;
  readonly onDecision?: (decision: DecisionReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * The history compactor schedule of `EngineOptions.compaction`.
 */
export interface CompactionOptions {
  readonly intervalMs: number;
  readonly policy: RetentionPolicy;
  readonly batchSize?: number;
}

/**
 * How many workflow decisions of an engine advanced a cached session
 * (`cache`) and how many replayed the history (`replay`).
 */
export interface DecisionTotals {
  readonly cache: number;
  readonly replay: number;
}

/**
 * A running engine: one worker plus the timer, schedule and janitor loops.
 * `workerId` is the identity stamped on its leases and sticky claims.
 */
export interface Engine {
  readonly queueName: string;
  readonly workerId: string;
  readonly schedules: ScheduleManager;
  readonly metrics: EngineMetrics;
  readonly recovery: RecoveryMetrics;
  decisionTotals(): DecisionTotals;
  /** Stops the loops, then drains the worker. */
  stop(): Promise<StopResult>;
}

/**
 * The queue `startEngine` serves when `queueName` is not given.
 */
export const DEFAULT_QUEUE_NAME = "default";

/**
 * Starts everything a process needs to run workflows: a worker that decides
 * workflow tasks and runs steps (see `createEngineTaskHandler`), the timer
 * loop that fires due durable timers, the schedule loop that starts cron
 * runs and the janitor loop that reclaims expired leases and recovers
 * stalled runs.
 */
export function startEngine(options: EngineOptions): Engine {
  const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
  const loopIntervalMs = options.loopIntervalMs ?? 1000;
  const onError = options.onError ?? ((): void => undefined);
  const clockOption = options.clock === undefined ? {} : { clock: options.clock };
  const poisonOption =
    options.poisonThreshold === undefined ? {} : { poisonThreshold: options.poisonThreshold };
  const identity = createWorkerIdentity({ version: options.buildId ?? "dev" });
  const stickyRouting = options.stickyRouting ?? true;
  const router = stickyRouting ? createStickyRouter(options.pool, clockOption) : undefined;
  const totals = { cache: 0, replay: 0 };
  const queue = createTaskQueue(options.pool, { ...clockOption, ...poisonOption });
  const schedules = createScheduleManager(options.pool, {
    queueName,
    ...clockOption,
    ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
  });
  const handler = createEngineTaskHandler({
    pool: options.pool,
    queue,
    queueName,
    workflows: options.workflows,
    steps: options.steps,
    ...clockOption,
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
    ...(options.maxCachedRuns === undefined ? {} : { maxCachedRuns: options.maxCachedRuns }),
    ...(options.stickyTimeoutMs === undefined ? {} : { stickyTimeoutMs: options.stickyTimeoutMs }),
    ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
    ...(router === undefined ? {} : { router, workerId: identity.id }),
    onDecision: (decision) => {
      if (decision.source === "cache") {
        totals.cache += 1;
      } else if (decision.source === "replay") {
        totals.replay += 1;
      }
      options.onDecision?.(decision);
    },
    onError,
  });
  const janitor = createJanitor(options.pool, { ...clockOption, ...poisonOption });
  const metrics = createEngineMetrics(options.pool, {
    recovery: janitor.metrics,
    queues: [queueName],
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const worker: Worker = createWorker({
    queue,
    queueName,
    handler,
    concurrency: options.concurrency ?? 4,
    pollIntervalMs: options.pollIntervalMs ?? 50,
    maxPollIntervalMs: 500,
    visibilityTimeoutMs: options.visibilityTimeoutMs ?? 30_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
    nackBackoff: options.nackBackoff ?? { initialMs: 250, maxMs: 30_000 },
    maxHandlerAttempts: options.maxHandlerAttempts ?? 8,
    identity,
    stickyRouting,
    onTaskSettled: (settled) => {
      metrics.observeTaskLatency(settled.task.queueName, settled.outcome, settled.latencySeconds);
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    onError,
  });
  const timerLoop: TimerLoop = startTimerLoop({
    scheduler: createTimerScheduler(options.pool, { queueName, ...clockOption }),
    intervalMs: loopIntervalMs,
    onError,
  });
  const scheduleLoop: ScheduleLoop = startScheduleLoop({
    manager: schedules,
    intervalMs: loopIntervalMs,
    onError,
  });
  const janitorLoop: JanitorLoop = startJanitorLoop({
    janitor,
    intervalMs: loopIntervalMs,
    stalledRuns: { queueName, graceMs: options.stalledRunGraceMs ?? 60_000 },
    onError,
  });
  const compactorLoop: CompactorLoop | undefined =
    options.compaction === undefined
      ? undefined
      : startCompactorLoop({
          compactor: createHistoryCompactor(options.pool, {
            clock: options.clock ?? systemClock,
            policy: options.compaction.policy,
          }),
          intervalMs: options.compaction.intervalMs,
          ...(options.compaction.batchSize === undefined
            ? {}
            : { batchSize: options.compaction.batchSize }),
          onError,
        });
  worker.start();

  return {
    queueName,
    workerId: identity.id,
    schedules,
    metrics,
    recovery: janitor.metrics,
    decisionTotals: () => ({ ...totals }),
    async stop(): Promise<StopResult> {
      await Promise.all([
        timerLoop.stop(),
        scheduleLoop.stop(),
        janitorLoop.stop(),
        compactorLoop?.stop(),
      ]);
      const result = await worker.stop();
      if (router !== undefined) {
        await router.releaseWorker(identity.id).catch(onError);
      }
      return result;
    },
  };
}
