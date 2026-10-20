import {
  createJanitor,
  createScheduleManager,
  createTaskQueue,
  createTimerScheduler,
  type ClockSource,
  type Pool,
  type RandomSource,
  type ScheduleManager,
  type Tracing,
} from "@dee/core";
import { createWorkerIdentity } from "../identity.js";
import { startJanitorLoop, type JanitorLoop } from "../janitor-loop.js";
import { startScheduleLoop, type ScheduleLoop } from "../schedule-loop.js";
import { startTimerLoop, type TimerLoop } from "../timer-loop.js";
import { createWorker, type StopResult, type Worker } from "../worker.js";
import {
  createEngineTaskHandler,
  type AnyStepDefinition,
  type AnyWorkflowDefinition,
  type DecisionReport,
} from "./task-handler.js";

/**
 * Configuration of `startEngine`. The loops run every `loopIntervalMs`
 * (default 1000); the janitor reclaims leases and recovers runs that made no
 * progress for `stalledRunGraceMs` (default 60000). `onError` receives every
 * error the engine survives.
 */
export interface EngineOptions {
  readonly pool: Pool;
  readonly queueName?: string;
  readonly workflows: readonly AnyWorkflowDefinition[];
  readonly steps: readonly AnyStepDefinition[];
  readonly buildId?: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly visibilityTimeoutMs?: number;
  readonly loopIntervalMs?: number;
  readonly stalledRunGraceMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly clock?: ClockSource;
  readonly random?: RandomSource;
  readonly tracing?: Tracing;
  readonly onDecision?: (decision: DecisionReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running engine: one worker plus the timer, schedule and janitor loops.
 */
export interface Engine {
  readonly queueName: string;
  readonly schedules: ScheduleManager;
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
  const queue = createTaskQueue(options.pool, clockOption);
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
    ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
    ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
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
    identity: createWorkerIdentity({ version: options.buildId ?? "dev" }),
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
    janitor: createJanitor(options.pool, clockOption),
    intervalMs: loopIntervalMs,
    stalledRuns: { queueName, graceMs: options.stalledRunGraceMs ?? 60_000 },
    onError,
  });
  worker.start();

  return {
    queueName,
    schedules,
    async stop(): Promise<StopResult> {
      await Promise.all([timerLoop.stop(), scheduleLoop.stop(), janitorLoop.stop()]);
      return worker.stop();
    },
  };
}
