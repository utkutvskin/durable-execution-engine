import {
  createEngineMetrics,
  createHistoryCompactor,
  createJanitor,
  createPendingStartFirer,
  createRetentionSweeper,
  createStickyRouter,
  createScheduleManager,
  createTaskQueue,
  createSessionConnector,
  createTimerScheduler,
  systemClock,
  type ClockSource,
  type EngineMetrics,
  type Pool,
  type RandomSource,
  type RateLimitRule,
  type RecoveryMetrics,
  type RetentionPolicy,
  type ScheduleManager,
  type TaskType,
  type Tracing,
} from "@dee/core";
import { startCompactorLoop, type CompactorLoop } from "../compactor-loop.ts";
import { startRetentionLoop, type RetentionLoop } from "../retention-loop.ts";
import { createWorkerIdentity } from "../identity.ts";
import { startJanitorLoop, type JanitorLoop } from "../janitor-loop.ts";
import { startLeaderElection, type LeaderElection } from "../leader-election.ts";
import { startWakeupListener, type WakeupListener } from "../wakeup-listener.ts";
import { startScheduleLoop, type ScheduleLoop } from "../schedule-loop.ts";
import { startTimerLoop, type TimerLoop } from "../timer-loop.ts";
import { createWorker, type NackBackoff, type StopResult, type Worker } from "../worker.ts";
import {
  createEngineTaskHandler,
  type AnyStepDefinition,
  type AnyWorkflowDefinition,
  type DecisionReport,
} from "./task-handler.ts";

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
 * `retention` (on by default, `false` turns it off) runs a retention sweep
 * every `intervalMs` (default `loopIntervalMs`): completed tasks older than
 * `finishedTaskGraceMs` move to `task_history`, and closed runs are purged
 * in every namespace with a retention (`closedRunRetentionMs`, or the
 * namespace's own; see `createRetentionSweeper`). Without either, no run
 * data is deleted.
 * `engine.metrics` renders the ten engine metrics: task latency is filled
 * from the worker and the reclaimed lease count from the janitor of this
 * engine.
 *
 * Workflow tasks and step tasks run in two separate pools, so steps that take
 * long never hold up a decision: `workflowConcurrency` decisions and
 * `stepConcurrency` steps run at once, each defaulting to `concurrency`
 * (default 4).
 *
 * `queueRateLimit` caps the steps started from the engine's queue per period,
 * shared through Postgres by every engine on the queue. The schedule loop
 * also fires due debounced starts and queued singleton starts.
 *
 * The timer, schedule, janitor, compactor and retention loops run on one engine per
 * queue and schema, elected through a session advisory lock
 * (`leaderElection`, default true; see `startLeaderElection`). Every engine
 * tries to take the lock once per `leaderLeaseMs` (default 1000), so a
 * killed leader is replaced within two lease periods. `isLeader` tells
 * whether this engine runs them.
 *
 * `wakeups` (default false) listens for the notification the `tasks`
 * insert trigger sends when the producing session has `dee.notify_wakeups`
 * on (`createPool({ notifyWakeups: true })`), and polls at once instead of
 * waiting out the empty-poll backoff; a decision that recorded events also
 * wakes this engine's step pool directly. Polling stays the fallback.
 *
 * The election and the listener each hold one dedicated session outside
 * the pool, opened with the pool's settings or at `sessionConnectionString`,
 * which must reach Postgres without a transaction-mode pooler in between.
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
  readonly workflowConcurrency?: number;
  readonly stepConcurrency?: number;
  readonly queueRateLimit?: RateLimitRule;
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
  readonly retention?: EngineRetentionOptions | false;
  readonly leaderElection?: boolean;
  readonly leaderLeaseMs?: number;
  readonly wakeups?: boolean;
  readonly sessionConnectionString?: string;
  readonly clock?: ClockSource;
  readonly random?: RandomSource;
  readonly tracing?: Tracing;
  readonly onDecision?: (decision: DecisionReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * The retention schedule of `EngineOptions.retention`. Every field is
 * optional; see `RetentionSweeperOptions` for `finishedTaskGraceMs`,
 * `closedRunRetentionMs` and `batchSize`.
 */
export interface EngineRetentionOptions {
  readonly intervalMs?: number;
  readonly finishedTaskGraceMs?: number;
  readonly closedRunRetentionMs?: number;
  readonly batchSize?: number;
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
 * A running engine: a decision pool and a step pool on one queue, plus the
 * timer, schedule and janitor loops.
 * `workerId` is the identity stamped on its leases and sticky claims.
 */
export interface Engine {
  readonly queueName: string;
  readonly workerId: string;
  readonly schedules: ScheduleManager;
  readonly metrics: EngineMetrics;
  readonly recovery: RecoveryMetrics;
  /** Whether this engine runs the queue's timer, schedule, janitor, compactor and retention loops. */
  readonly isLeader: boolean;
  decisionTotals(): DecisionTotals;
  /** Stops the loops, then drains the worker. */
  stop(): Promise<StopResult>;
}

interface BackgroundLoops {
  readonly timer: TimerLoop;
  readonly schedule: ScheduleLoop;
  readonly janitor: JanitorLoop;
  readonly compactor: CompactorLoop | undefined;
  readonly retention: RetentionLoop | undefined;
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
    ...(options.queueRateLimit === undefined ? {} : { queueRateLimit: options.queueRateLimit }),
    ...(router === undefined ? {} : { router, workerId: identity.id }),
    onDecision: (decision) => {
      if (decision.source === "cache") {
        totals.cache += 1;
      } else if (decision.source === "replay") {
        totals.replay += 1;
      }
      if (options.wakeups === true && decision.recordedEvents > 0) {
        stepPool.wake();
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
  const concurrency = options.concurrency ?? 4;
  const createPool = (taskType: TaskType, poolConcurrency: number): Worker =>
    createWorker({
      queue,
      queueName,
      handler,
      taskTypes: [taskType],
      concurrency: poolConcurrency,
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
  const stepPool = createPool("STEP_TASK", options.stepConcurrency ?? concurrency);
  const workers: readonly Worker[] = [
    createPool("WORKFLOW_TASK", options.workflowConcurrency ?? concurrency),
    stepPool,
  ];
  const timerScheduler = createTimerScheduler(options.pool, { queueName, ...clockOption });
  const pendingStarts = createPendingStartFirer(options.pool, clockOption);
  const compactor =
    options.compaction === undefined
      ? undefined
      : createHistoryCompactor(options.pool, {
          clock: options.clock ?? systemClock,
          policy: options.compaction.policy,
        });
  const retention = options.retention === false ? undefined : (options.retention ?? {});
  const sweeper =
    retention === undefined
      ? undefined
      : createRetentionSweeper(options.pool, {
          ...clockOption,
          ...(retention.finishedTaskGraceMs === undefined
            ? {}
            : { finishedTaskGraceMs: retention.finishedTaskGraceMs }),
          ...(retention.closedRunRetentionMs === undefined
            ? {}
            : { closedRunRetentionMs: retention.closedRunRetentionMs }),
          ...(retention.batchSize === undefined ? {} : { batchSize: retention.batchSize }),
        });
  let running: BackgroundLoops | undefined;
  const startLoops = (): void => {
    running ??= {
      timer: startTimerLoop({ scheduler: timerScheduler, intervalMs: loopIntervalMs, onError }),
      schedule: startScheduleLoop({
        manager: schedules,
        pendingStarts,
        intervalMs: loopIntervalMs,
        onError,
      }),
      janitor: startJanitorLoop({
        janitor,
        intervalMs: loopIntervalMs,
        stalledRuns: { queueName, graceMs: options.stalledRunGraceMs ?? 60_000 },
        onError,
      }),
      compactor:
        compactor === undefined || options.compaction === undefined
          ? undefined
          : startCompactorLoop({
              compactor,
              intervalMs: options.compaction.intervalMs,
              ...(options.compaction.batchSize === undefined
                ? {}
                : { batchSize: options.compaction.batchSize }),
              onError,
            }),
      retention:
        sweeper === undefined
          ? undefined
          : startRetentionLoop({
              sweeper,
              intervalMs: retention?.intervalMs ?? loopIntervalMs,
              onError,
            }),
    };
  };
  const stopLoops = async (): Promise<void> => {
    const loops = running;
    running = undefined;
    if (loops === undefined) {
      return;
    }
    await Promise.all([
      loops.timer.stop(),
      loops.schedule.stop(),
      loops.janitor.stop(),
      loops.compactor?.stop(),
      loops.retention?.stop(),
    ]);
  };
  const connect = createSessionConnector(
    options.pool,
    options.sessionConnectionString === undefined
      ? {}
      : { connectionString: options.sessionConnectionString },
  );
  const election: LeaderElection | undefined =
    options.leaderElection === false
      ? undefined
      : startLeaderElection({
          connect,
          key: queueName,
          ...(options.leaderLeaseMs === undefined ? {} : { leasePeriodMs: options.leaderLeaseMs }),
          onElected: startLoops,
          onDeposed: stopLoops,
          onError,
        });
  if (election === undefined) {
    startLoops();
  }
  const listener: WakeupListener | undefined =
    options.wakeups === true
      ? startWakeupListener({
          connect,
          queueName,
          onWake: () => {
            workers.forEach((worker) => {
              worker.wake();
            });
          },
          onError,
        })
      : undefined;
  workers.forEach((worker) => {
    worker.start();
  });

  return {
    queueName,
    workerId: identity.id,
    schedules,
    metrics,
    recovery: janitor.metrics,
    get isLeader(): boolean {
      return election === undefined ? true : election.isLeader;
    },
    decisionTotals: () => ({ ...totals }),
    async stop(): Promise<StopResult> {
      await Promise.all([election?.stop(), listener?.stop()]);
      await stopLoops();
      const results = await Promise.all(workers.map((worker) => worker.stop()));
      const result: StopResult = {
        completed: results.reduce((total, entry) => total + entry.completed, 0),
        dropped: results.reduce((total, entry) => total + entry.dropped, 0),
      };
      if (router !== undefined) {
        await router.releaseWorker(identity.id).catch(onError);
      }
      return result;
    },
  };
}
