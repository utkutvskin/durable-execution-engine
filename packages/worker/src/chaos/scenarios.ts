import {
  createJanitor,
  createPool,
  createPostgresEventStore,
  createTaskQueue,
  createTimerScheduler,
  type LeasedTask,
} from "@dee/core";
import { CRASH_POINTS, createFlowHandler } from "./flow.js";
import { startFaultProxy } from "./fault-proxy.js";
import { spawnChaosChild } from "./process-harness.js";
import { createSlowDiskPool } from "./slow-pool.js";
import { createSeededRandom } from "./seeded-random.js";
import {
  createChaosHandler,
  createShiftableClock,
  createTimerRunHandler,
  databaseTarget,
  mergeWorkloads,
  proxiedEnv,
  settle,
  startFlowRuns,
  startWorkers,
  TIMER_RUN_RESULT,
  verifyWorkload,
  whenStuck,
  type ChaosViolation,
  type ChaosWorld,
  type Workload,
} from "./world.js";

/**
 * The failure scenarios of the chaos suite.
 */
export const SCENARIO_NAMES = [
  "worker-kill",
  "db-connection-loss",
  "double-delivery",
  "clock-shift",
  "slow-disk",
  "network-latency",
] as const;

/**
 * One of the values of `SCENARIO_NAMES`.
 */
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/**
 * What one repetition of a scenario is given.
 */
export interface RepetitionContext {
  readonly repetition: number;
  readonly seed: number;
  readonly random: () => number;
  readonly queueName: string;
}

/**
 * What a scenario hands back after injecting its faults and letting the
 * system recover: the workload it created, whether the workload finished,
 * how many faults it injected, how many errors the engine survived and any
 * violations the scenario found on its own.
 */
export interface ScenarioOutcome {
  readonly workload: Workload;
  readonly converged: boolean;
  readonly faults: number;
  readonly survivedErrors: number;
  readonly violations?: readonly ChaosViolation[];
}

/**
 * A failure scenario: what it breaks, in prose for the report, and how to run
 * one repetition of it.
 */
export interface ChaosScenario {
  readonly name: ScenarioName;
  readonly title: string;
  readonly injection: string;
  readonly fidelity: string;
  run(world: ChaosWorld, context: RepetitionContext): Promise<ScenarioOutcome>;
}

/**
 * The result of one repetition, after the invariant checker ran.
 */
export interface RepetitionResult {
  readonly scenario: ScenarioName;
  readonly repetition: number;
  readonly seed: number;
  readonly durationMs: number;
  readonly runs: number;
  readonly tasks: number;
  readonly faults: number;
  readonly survivedErrors: number;
  readonly redeliveries: number;
  readonly violations: readonly ChaosViolation[];
}

const NO_ABORT = { signal: new AbortController().signal };
const NEVER_QUARANTINE = 50;

async function yieldRandomly(random: () => number): Promise<void> {
  for (let turns = Math.floor(random() * 4); turns > 0; turns -= 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const workerKill: ChaosScenario = {
  name: "worker-kill",
  title: "Worker kill",
  injection:
    "Two worker processes each take a task and are stopped with SIGKILL at a random point (before the step result is recorded, after it, or after the run finished but before the ack). A janitor reclaims their leases and two fresh workers finish every run.",
  fidelity:
    "Real operating system processes and a real signal. The kill lands only at the three checkpoints of the sample flow, not at an arbitrary instruction.",
  async run(world, context) {
    const clock = createShiftableClock();
    const workload = await startFlowRuns(world, context.queueName, 4);
    const children = [0, 1].map(() => {
      const crashPoint = CRASH_POINTS[Math.floor(context.random() * CRASH_POINTS.length)];
      if (crashPoint === undefined) {
        throw new Error("no crash point");
      }
      return {
        crashPoint,
        child: spawnChaosChild({
          schema: world.database.schema,
          queueName: context.queueName,
          crashPoint,
          version: "1.0.0",
        }),
      };
    });
    await Promise.all(children.map(({ child }) => child.waitForLine("ready")));
    await Promise.all(
      children.map(({ child, crashPoint }) => child.waitForLine(`checkpoint ${crashPoint}`)),
    );
    await Promise.all(children.map(({ child }) => child.kill("SIGKILL")));

    clock.shift(120_000);
    const janitor = createJanitor(world.database.pool, {
      clock,
      poisonThreshold: NEVER_QUARANTINE,
    });
    await janitor.reclaimOrphanedLeases();
    const workers = startWorkers({
      pool: world.database.pool,
      store: world.store,
      queueName: context.queueName,
      count: 2,
      concurrency: 2,
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 5_000,
      clock,
    });
    const converged = await settle(
      world,
      workload,
      whenStuck(world, workload, 20, async () => {
        clock.shift(120_000);
        await janitor.reclaimOrphanedLeases();
      }),
    );
    await workers.stop();
    return { workload, converged, faults: children.length, survivedErrors: workers.errors.length };
  },
};

const dbConnectionLoss: ChaosScenario = {
  name: "db-connection-loss",
  title: "Database connection loss and recovery",
  injection:
    "The workers reach Postgres through a TCP proxy. At the checkpoints of the flow the proxy destroys every open connection, refuses the next reconnects, or lets a commit execute while swallowing its answer, so the worker cannot tell whether the transaction applied. A janitor reclaims what the workers could not nack.",
  fidelity:
    "The connections really die and pg really has to reconnect, but Postgres itself keeps running; a restarted server is not simulated.",
  async run(world, context) {
    const clock = createShiftableClock();
    const target = databaseTarget();
    const proxy = await startFaultProxy(target.host, target.port);
    const poolErrors: Error[] = [];
    const pool = createPool(proxiedEnv(proxy.port), {
      schema: world.database.schema,
      max: 4,
      onError: (error) => poolErrors.push(error),
    });
    const workload = await startFlowRuns(world, context.queueName, 6);
    const janitor = createJanitor(world.database.pool, {
      clock,
      poisonThreshold: NEVER_QUARANTINE,
    });
    let faults = 0;
    const budget = 8;
    const workers = startWorkers({
      pool,
      store: createPostgresEventStore(pool),
      queueName: context.queueName,
      count: 2,
      concurrency: 2,
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 5_000,
      clock,
      onCheckpoint: async () => {
        if (faults >= budget || (faults > 0 && context.random() > 0.4)) {
          return;
        }
        faults += 1;
        const kind = Math.floor(context.random() * 3);
        if (kind === 0) {
          proxy.sever();
        } else if (kind === 1) {
          proxy.refuseNext(2);
          proxy.sever();
        } else {
          proxy.dropResponseToNextCommits(1);
        }
        await Promise.resolve();
      },
    });
    const converged = await settle(
      world,
      workload,
      whenStuck(world, workload, 20, async () => {
        clock.shift(60_000);
        await janitor.reclaimOrphanedLeases();
      }),
    );
    await workers.stop();
    await pool.end();
    await proxy.close();
    return {
      workload,
      converged,
      faults,
      survivedErrors: workers.errors.length + poolErrors.length,
    };
  },
};

const doubleDelivery: ChaosScenario = {
  name: "double-delivery",
  title: "Double delivery",
  injection:
    "Every task is leased, its visibility timeout expires, and it is delivered again, two to four times in all. Every delivery then runs concurrently, with random pauses between the steps of the handler, and each acks with its own lease token.",
  fidelity:
    "Real concurrent handlers over the real recorder and queue; the deliveries come from a moved clock rather than from a worker that really stalled.",
  async run(world, context) {
    const clock = createShiftableClock();
    const pool = world.database.pool;
    const queue = createTaskQueue(pool, { clock });
    const workload = await startFlowRuns(world, context.queueName, 4, clock);
    const handler = createFlowHandler({
      pool,
      store: world.store,
      onCheckpoint: () => yieldRandomly(context.random),
    });
    const deliveries: LeasedTask[] = [];
    const copies = 2 + (context.repetition % 3);
    for (let copy = 0; copy < copies; copy += 1) {
      deliveries.push(
        ...(await queue.dequeue({
          queueName: context.queueName,
          visibilityTimeoutMs: 1_000,
          limit: 10,
        })),
      );
      clock.shift(5_000);
    }
    let handlerErrors = 0;
    const accepted = await Promise.all(
      deliveries.map(async (task) => {
        try {
          await handler(task, NO_ABORT);
          return await queue.ack(task.id, task.leaseToken);
        } catch {
          handlerErrors += 1;
          return queue.nack(task.id, task.leaseToken);
        }
      }),
    );
    const violations: ChaosViolation[] = [];
    const acked = accepted.filter(Boolean).length;
    if (acked > workload.taskIds.length) {
      violations.push({
        check: "ack-accepted-once",
        runId: null,
        detail: `${String(acked)} acks were accepted for ${String(workload.taskIds.length)} tasks`,
      });
    }
    const workers = startWorkers({
      pool,
      store: world.store,
      queueName: context.queueName,
      count: 1,
      concurrency: 2,
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 5_000,
      clock,
    });
    const converged = await settle(
      world,
      workload,
      whenStuck(world, workload, 20, async () => {
        clock.shift(60_000);
        await Promise.resolve();
      }),
    );
    await workers.stop();
    return {
      workload,
      converged,
      faults: deliveries.length - workload.taskIds.length,
      survivedErrors: handlerErrors + workers.errors.length,
      violations,
    };
  },
};

const clockShift: ChaosScenario = {
  name: "clock-shift",
  title: "Clock shifted forward and backward",
  injection:
    "Four runs wait on durable timers of 10 to 13 minutes and two runs have pending step tasks, one of them leased by a worker that vanished. The shared clock is moved backward and forward by minutes to hours several times, with two timer schedulers and a janitor ticking after every move, then jumps two days ahead.",
  fidelity:
    "The clock is an injected source, which is how every component reads time; the operating system clock is not changed.",
  async run(world, context) {
    const clock = createShiftableClock();
    const pool = world.database.pool;
    const queueName = context.queueName;
    const queue = createTaskQueue(pool, { clock });
    const scheduler = createTimerScheduler(pool, { queueName, clock, batchSize: 3 });
    const racing = createTimerScheduler(pool, { queueName, clock, batchSize: 3 });
    const janitor = createJanitor(pool, { clock, poisonThreshold: NEVER_QUARANTINE });
    const flow = await startFlowRuns(world, queueName, 2, clock);
    const timerRunIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const fireAt = new Date(clock.now().getTime() + (10 + index) * 60_000);
      const run = await pool.query<{ id: string }>(
        "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'sleeper') returning id",
        [world.namespaceId],
      );
      const runId = run.rows[0]?.id ?? "";
      await world.store.append(runId, 0, [
        { type: "run_started", workflowType: "sleeper", input: {} },
        { type: "timer_started", timerId: "t1", fireAt: fireAt.toISOString() },
      ]);
      await scheduler.schedule({ runId, timerId: "t1", fireAt });
      timerRunIds.push(runId);
    }
    const timerWorkload: Workload = {
      runIds: timerRunIds,
      taskIds: [],
      expectedResults: new Map(timerRunIds.map((runId) => [runId, TIMER_RUN_RESULT])),
    };
    const workload = mergeWorkloads(flow, timerWorkload);
    await queue.dequeue({ queueName, visibilityTimeoutMs: 30_000, limit: 1, workerId: "vanished" });

    const handler = createChaosHandler(
      createFlowHandler({ pool, store: world.store }),
      createTimerRunHandler(pool, world.store),
    );
    let handlerErrors = 0;
    async function drain(): Promise<void> {
      await Promise.all([scheduler.catchUp(), racing.catchUp()]);
      await janitor.reclaimOrphanedLeases();
      for (;;) {
        const tasks = await queue.dequeue({
          queueName,
          visibilityTimeoutMs: 30_000,
          limit: 10,
          workerId: "drain",
        });
        if (tasks.length === 0) {
          return;
        }
        await Promise.all(
          tasks.map(async (task) => {
            try {
              await handler(task, NO_ABORT);
              await queue.ack(task.id, task.leaseToken);
            } catch {
              handlerErrors += 1;
              await queue.nack(task.id, task.leaseToken);
            }
          }),
        );
      }
    }

    const minute = 60_000;
    const moves = [
      -(60 + Math.floor(context.random() * 60)) * minute,
      (1 + Math.floor(context.random() * 20)) * minute,
      -(1 + Math.floor(context.random() * 30)) * minute,
      (10 + Math.floor(context.random() * 30)) * minute,
      -(60 + Math.floor(context.random() * 60)) * minute,
    ];
    for (const move of moves) {
      clock.shift(move);
      await drain();
    }
    clock.shift(2 * 24 * 60 * minute);
    const converged = await settle(world, workload, async () => {
      clock.shift(minute);
      await drain();
    });
    const regressions = scheduler.clockRegressions + racing.clockRegressions;
    return {
      workload,
      converged,
      faults: regressions > 0 ? moves.length + 1 : 0,
      survivedErrors: handlerErrors,
    };
  },
};

const slowDisk: ChaosScenario = {
  name: "slow-disk",
  title: "Slow disk",
  injection:
    "Every insert, update, delete and commit takes 8 to 27 ms. Three workers with a 40 ms visibility timeout and a 15 ms heartbeat compete for eight runs, so leases expire in the middle of slow transactions and tasks are delivered to a second worker while the first is still writing.",
  fidelity:
    "The delay is added in front of write statements by a wrapper around the pool; the real disk and the real fsync are unchanged, and Postgres sees ordinary statements that arrive later.",
  async run(world, context) {
    let delayedStatements = 0;
    const slow = createSlowDiskPool(world.database.pool, () => {
      delayedStatements += 1;
      return 8 + Math.floor(context.random() * 20);
    });
    const workload = await startFlowRuns(world, context.queueName, 8);
    const workers = startWorkers({
      pool: slow,
      store: createPostgresEventStore(slow),
      queueName: context.queueName,
      count: 3,
      concurrency: 2,
      visibilityTimeoutMs: 40,
      heartbeatIntervalMs: 15,
    });
    const converged = await settle(world, workload, () => Promise.resolve());
    await workers.stop();
    return {
      workload,
      converged,
      faults: delayedStatements,
      survivedErrors: workers.errors.length,
    };
  },
};

const networkLatency: ChaosScenario = {
  name: "network-latency",
  title: "Network latency",
  injection:
    "The workers reach Postgres through a TCP proxy that delays every packet in both directions by 2 to 9 ms, with bursts of 150 ms at some checkpoints. Two workers with an 80 ms visibility timeout and a 25 ms heartbeat compete for six runs, so heartbeats arrive late and leases are lost.",
  fidelity:
    "The delay is real packet delay on a local TCP connection; bandwidth limits, packet loss and reordering across hosts are not simulated.",
  async run(world, context) {
    const target = databaseTarget();
    const proxy = await startFaultProxy(target.host, target.port);
    let delayedChunks = 0;
    let burst = 0;
    proxy.setLatency(() => {
      delayedChunks += 1;
      if (burst > 0) {
        burst -= 1;
        return 150;
      }
      return 2 + Math.floor(context.random() * 8);
    });
    const poolErrors: Error[] = [];
    const pool = createPool(proxiedEnv(proxy.port), {
      schema: world.database.schema,
      max: 6,
      onError: (error) => poolErrors.push(error),
    });
    const workload = await startFlowRuns(world, context.queueName, 6);
    let bursts = 0;
    const workers = startWorkers({
      pool,
      store: createPostgresEventStore(pool),
      queueName: context.queueName,
      count: 2,
      concurrency: 2,
      visibilityTimeoutMs: 80,
      heartbeatIntervalMs: 25,
      onCheckpoint: async () => {
        if (bursts < 4 && context.random() < 0.5) {
          bursts += 1;
          burst = 6;
        }
        await Promise.resolve();
      },
    });
    const converged = await settle(world, workload, () => Promise.resolve());
    await workers.stop();
    await pool.end();
    await proxy.close();
    return {
      workload,
      converged,
      faults: delayedChunks,
      survivedErrors: workers.errors.length + poolErrors.length,
    };
  },
};

/**
 * Every scenario of the suite, in the order of `SCENARIO_NAMES`.
 */
export const SCENARIOS: readonly ChaosScenario[] = [
  workerKill,
  dbConnectionLoss,
  doubleDelivery,
  clockShift,
  slowDisk,
  networkLatency,
];

/**
 * Runs one repetition of `scenario` in `world`, then checks the workload it
 * left behind. A scenario that throws is reported as a violation rather than
 * propagated, so a harness failure can never pass as a clean run. A
 * repetition that injected no fault is a violation too, because it proved
 * nothing.
 */
export async function runRepetition(
  scenario: ChaosScenario,
  world: ChaosWorld,
  repetition: number,
): Promise<RepetitionResult> {
  const seed = (SCENARIO_NAMES.indexOf(scenario.name) + 1) * 1000 + repetition;
  const started = performance.now();
  const context: RepetitionContext = {
    repetition,
    seed,
    random: createSeededRandom(seed),
    queueName: `chaos/${scenario.name}-${String(repetition)}`,
  };
  try {
    const outcome = await scenario.run(world, context);
    const verified = await verifyWorkload(world, outcome.workload, outcome.converged);
    const redelivered = await world.database.pool.query<{ extra: string }>(
      "select coalesce(sum(attempts - 1), 0) as extra from tasks where run_id = any($1::uuid[]) and attempts > 1",
      [[...outcome.workload.runIds]],
    );
    const violations = [...(outcome.violations ?? []), ...verified.violations];
    if (outcome.faults <= 0) {
      violations.push({
        check: "fault-injected",
        runId: null,
        detail: "the repetition injected no fault",
      });
    }
    return {
      scenario: scenario.name,
      repetition,
      seed,
      durationMs: Math.round(performance.now() - started),
      runs: outcome.workload.runIds.length,
      tasks: outcome.workload.taskIds.length,
      faults: outcome.faults,
      survivedErrors: outcome.survivedErrors,
      redeliveries: Number(redelivered.rows[0]?.extra),
      violations,
    };
  } catch (error) {
    return {
      scenario: scenario.name,
      repetition,
      seed,
      durationMs: Math.round(performance.now() - started),
      runs: 0,
      tasks: 0,
      faults: 0,
      survivedErrors: 0,
      redeliveries: 0,
      violations: [
        {
          check: "scenario-error",
          runId: null,
          detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
        },
      ],
    };
  }
}
