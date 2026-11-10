import { createEngineTaskHandler } from "../engine/task-handler.ts";
import type { TaskHandler } from "../worker.ts";
import {
  ENGINE_RUN_RESULT,
  createEngineFlow,
  engineRunService,
  startEngineRuns,
  startEngines,
  type EngineFlowHooks,
} from "./engine-kit.ts";
import {
  createJanitor,
  createPool,
  createPostgresEventStore,
  createTaskQueue,
  createTimerScheduler,
  type ClockSource,
  type LeasedTask,
} from "@dee/core";
import { CRASH_POINTS, createFlowHandler } from "./flow.ts";
import { startFaultProxy } from "./fault-proxy.ts";
import { spawnChaosChild } from "./process-harness.ts";
import { createSlowDiskPool } from "./slow-pool.ts";
import { createSeededRandom } from "./seeded-random.ts";
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
  type WorkerGroup,
  type WorkerGroupOptions,
  type Workload,
} from "./world.ts";

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
  "slow-attempt-race",
  "two-queues",
  "clock-skew",
  "small-pool",
  "signal-wait",
] as const;

/**
 * What a scenario drives: `recorder` is the sample flow over the result
 * recorder (the original suite), `engine` is `startEngine` running real
 * workflows and steps.
 */
export type RuntimeKind = "recorder" | "engine";

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
  readonly runtime: RuntimeKind;
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
  readonly runtime: RuntimeKind;
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
  readonly runtime: RuntimeKind;
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

type ScenarioBody = Omit<ChaosScenario, "runtime">;

function startRuns(
  world: ChaosWorld,
  context: RepetitionContext,
  count: number,
  clock?: ClockSource,
): Promise<Workload> {
  return context.runtime === "engine"
    ? startEngineRuns(world, context.queueName, count)
    : startFlowRuns(world, context.queueName, count, clock);
}

function startNodes(context: RepetitionContext, options: WorkerGroupOptions): WorkerGroup {
  if (context.runtime !== "engine") {
    return startWorkers(options);
  }
  const hooks: EngineFlowHooks =
    options.onCheckpoint === undefined ? {} : { onCheckpoint: options.onCheckpoint };
  return startEngines({
    pool: options.pool,
    queueName: options.queueName,
    count: options.count,
    concurrency: options.concurrency,
    visibilityTimeoutMs: options.visibilityTimeoutMs,
    hooks,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

const CHECKPOINT_DEADLINE_MS = 5_000;
const NO_ABORT = { signal: new AbortController().signal };
const NEVER_QUARANTINE = 50;
const ENGINE_SEED_OFFSET = 100_000;

async function yieldRandomly(random: () => number): Promise<void> {
  for (let turns = Math.floor(random() * 4); turns > 0; turns -= 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const workerKill: ScenarioBody = {
  name: "worker-kill",
  title: "Worker kill",
  injection:
    "Two worker processes each take a task and are stopped with SIGKILL at a random point (before the step result is recorded, after it, or after the run finished but before the ack). A janitor reclaims their leases and two fresh workers finish every run.",
  fidelity:
    "Real operating system processes and a real signal. The kill lands only at the three checkpoints of the sample flow, not at an arbitrary instruction.",
  async run(world, context) {
    const clock = createShiftableClock();
    const workload = await startRuns(world, context, 4);
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
          runtime: context.runtime,
        }),
      };
    });
    await Promise.all(children.map(({ child }) => child.waitForLine("ready")));
    await Promise.all(
      children.map(({ child, crashPoint }) =>
        child
          .waitForLine(`checkpoint ${crashPoint}`, CHECKPOINT_DEADLINE_MS)
          .catch(() => undefined),
      ),
    );
    await Promise.all(children.map(({ child }) => child.kill("SIGKILL")));

    clock.shift(120_000);
    const janitor = createJanitor(world.database.pool, {
      clock,
      poisonThreshold: NEVER_QUARANTINE,
    });
    await janitor.reclaimOrphanedLeases();
    const workers = startNodes(context, {
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

const dbConnectionLoss: ScenarioBody = {
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
    const workload = await startRuns(world, context, 6);
    const janitor = createJanitor(world.database.pool, {
      clock,
      poisonThreshold: NEVER_QUARANTINE,
    });
    let faults = 0;
    const budget = 8;
    const workers = startNodes(context, {
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

const doubleDelivery: ScenarioBody = {
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
    const workload = await startRuns(world, context, 4, clock);
    const handler =
      context.runtime === "engine"
        ? createEngineDeliveryHandler(world, context, queue, clock)
        : createFlowHandler({
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
    const workers = startNodes(context, {
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

const clockShift: ScenarioBody = {
  name: "clock-shift",
  title: "Clock shifted forward and backward",
  injection:
    "Four runs wait on durable timers of 10 to 13 minutes and two runs have pending step tasks, one of them leased by a worker that vanished. The shared clock is moved backward and forward by minutes to hours several times, with two timer schedulers and a janitor ticking after every move, then jumps two days ahead.",
  fidelity:
    "The clock is an injected source, which is how every component reads time; the operating system clock is not changed.",
  async run(world, context) {
    if (context.runtime === "engine") {
      return runEngineClockShift(world, context);
    }
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
        "insert into workflow_runs (namespace_id, workflow_type, queue_name) values ($1, 'sleeper', $2) returning id",
        [world.namespaceId, queueName],
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

const slowDisk: ScenarioBody = {
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
    const workload = await startRuns(world, context, 8);
    const workers = startNodes(context, {
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

const networkLatency: ScenarioBody = {
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
    const workload = await startRuns(world, context, 6);
    let bursts = 0;
    const workers = startNodes(context, {
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

function createEngineDeliveryHandler(
  world: ChaosWorld,
  context: RepetitionContext,
  queue: ReturnType<typeof createTaskQueue>,
  clock: ClockSource,
): TaskHandler {
  const flow = createEngineFlow({ onCheckpoint: () => yieldRandomly(context.random) });
  return createEngineTaskHandler({
    pool: world.database.pool,
    queue,
    queueName: context.queueName,
    workflows: flow.workflows,
    steps: flow.steps,
    clock,
  });
}

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => Promise<boolean>, deadlineMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await pause(5);
  }
  return false;
}

async function runEngineClockShift(
  world: ChaosWorld,
  context: RepetitionContext,
): Promise<ScenarioOutcome> {
  const clock = createShiftableClock();
  const pool = world.database.pool;
  const queueName = context.queueName;
  const flow = await startEngineRuns(world, queueName, 2);
  const sleepers = await startEngineRuns(world, queueName, 4, {
    workflowType: "sleeper",
    input: (index) => ({ ms: (10 + index) * 60_000 }),
    expected: () => ENGINE_RUN_RESULT,
  });
  const workload = mergeWorkloads(flow, sleepers);
  await createTaskQueue(pool, { clock }).dequeue({
    queueName,
    visibilityTimeoutMs: 30_000,
    limit: 1,
    workerId: "vanished",
  });
  const engines = startEngines({
    pool,
    queueName,
    count: 2,
    concurrency: 2,
    visibilityTimeoutMs: 30_000,
    clock,
  });
  const minute = 60_000;
  const moves = [
    -(60 + Math.floor(context.random() * 60)) * minute,
    (1 + Math.floor(context.random() * 20)) * minute,
    -(1 + Math.floor(context.random() * 30)) * minute,
    (10 + Math.floor(context.random() * 30)) * minute,
    -(60 + Math.floor(context.random() * 60)) * minute,
    2 * 24 * 60 * minute,
  ];
  let moved = 0;
  const stuck = whenStuck(world, workload, 4, async () => {
    const move = moves[moved];
    clock.shift(move ?? minute);
    moved += 1;
    await Promise.resolve();
  });
  const converged = await settle(world, workload, stuck);
  await engines.stop();
  return {
    workload,
    converged,
    faults: Math.min(moved, moves.length),
    survivedErrors: engines.errors.length,
  };
}

const slowAttemptRace: ScenarioBody = {
  name: "slow-attempt-race",
  title: "Slow attempt racing a retry",
  injection:
    "Three runs each start a step whose first attempt hangs on a gate while an engine holds its lease. A second engine whose clock runs ten minutes ahead sees the lease as expired, takes the task and finishes the step. The gate then opens and the first attempt ends late, with a wrong result on odd repetitions and with an error on even ones.",
  fidelity:
    "Two real engines over one database. The expired lease comes from the clock of the second engine, not from a worker that really stalled, and the first attempt ignores its abort signal on purpose.",
  async run(world, context) {
    const calls = new Map<number, number>();
    const gate = createGate();
    let reached = 0;
    let late = 0;
    const hooks: EngineFlowHooks = {
      race: async (_attempt, value) => {
        const call = (calls.get(value) ?? 0) + 1;
        calls.set(value, call);
        if (call > 1) {
          return value * 2;
        }
        reached += 1;
        await gate.promise;
        late += 1;
        if (context.repetition % 2 === 0) {
          throw new Error("late attempt failed");
        }
        return -1;
      },
    };
    const workload = await startEngineRuns(world, context.queueName, 3, {
      workflowType: "racer",
    });
    const first = startEngines({
      pool: world.database.pool,
      queueName: context.queueName,
      count: 1,
      concurrency: 4,
      visibilityTimeoutMs: 30_000,
      hooks,
    });
    const gated = await until(() => Promise.resolve(reached === 3));
    const ahead = createShiftableClock();
    ahead.shift(10 * 60_000);
    const second = startEngines({
      pool: world.database.pool,
      queueName: context.queueName,
      count: 1,
      concurrency: 4,
      visibilityTimeoutMs: 30_000,
      clock: ahead,
      hooks,
    });
    const converged = gated && (await settle(world, workload, () => Promise.resolve()));
    gate.open();
    await until(() => Promise.resolve(late === 3), 5_000);
    await Promise.all([first.stop(), second.stop()]);
    return {
      workload,
      converged,
      faults: late,
      survivedErrors: first.errors.length + second.errors.length,
    };
  },
};

const twoQueues: ScenarioBody = {
  name: "two-queues",
  title: "Two queues on one database",
  injection:
    "Two pairs of engines serve two queues, each queue with its own workflow types, on one database and one shared clock. Each queue has doubling runs and a sleeping run, and one workflow task of each queue is deleted before the engines start. The clock is moved forward until the janitor of each queue has recovered its own lost task.",
  fidelity:
    "Real engines and a real janitor per queue. A task that reached the wrong queue would meet an engine that does not know its workflow type and park, which the queue check and the convergence check both catch.",
  async run(world, context) {
    const clock = createShiftableClock();
    const pool = world.database.pool;
    const names = [`${context.queueName}-a`, `${context.queueName}-b`] as const;
    const workloads: Workload[] = [];
    const lost = new Set<string>();
    for (const [index, queueName] of names.entries()) {
      const suffix = index === 0 ? "-a" : "-b";
      const doubles = await startEngineRuns(world, queueName, 3, {
        workflowType: `double${suffix}`,
      });
      const sleeper = await startEngineRuns(world, queueName, 1, {
        workflowType: `sleeper${suffix}`,
        input: () => ({ ms: 5 * 60_000 }),
        expected: () => ENGINE_RUN_RESULT,
      });
      const target = doubles.runIds[0];
      const removed = await pool.query<{ id: string }>(
        "delete from tasks where run_id = $1 and state = 'PENDING' returning id",
        [target],
      );
      removed.rows.forEach((row) => lost.add(row.id));
      workloads.push(doubles, sleeper);
    }
    const merged = mergeWorkloads(...workloads);
    const workload: Workload = {
      ...merged,
      taskIds: merged.taskIds.filter((id) => !lost.has(id)),
    };
    const groups = names.map((queueName, index) =>
      startEngines({
        pool,
        queueName,
        count: 2,
        concurrency: 2,
        visibilityTimeoutMs: 30_000,
        clock,
        suffix: index === 0 ? "-a" : "-b",
      }),
    );
    const converged = await settle(
      world,
      workload,
      whenStuck(world, workload, 4, async () => {
        clock.shift(90_000);
        await Promise.resolve();
      }),
    );
    await Promise.all(groups.map((group) => group.stop()));
    const crossed = await pool.query<{ id: string }>(
      `select t.id from tasks t join workflow_runs r on r.id = t.run_id
       where t.queue_name <> r.queue_name and r.id = any($1::uuid[])`,
      [[...workload.runIds]],
    );
    const violations: ChaosViolation[] = crossed.rows.map((row) => ({
      check: "queue-isolation",
      runId: null,
      detail: `task ${row.id} sits on a different queue than its run`,
    }));
    return {
      workload,
      converged,
      faults: lost.size,
      survivedErrors: groups.reduce((total, group) => total + group.errors.length, 0),
      violations,
    };
  },
};

const clockSkew: ScenarioBody = {
  name: "clock-skew",
  title: "Clock skew between workers",
  injection:
    "Three engines on one queue read clocks that differ by 90 seconds in both directions while the visibility timeout is 30 seconds, so each sees the leases of the others as expired or as far in the future. All three clocks advance together, and the runs include two durable sleeps. Steps pause for a few milliseconds so deliveries overlap.",
  fidelity:
    "Each engine has its own injected clock source, which is how every engine component reads time; the operating system clocks are not changed, and the database clock stays the one truth for components that use it.",
  async run(world, context) {
    const offsets = [-90_000, 0, 90_000];
    const clocks = offsets.map((offset) => {
      const clock = createShiftableClock();
      clock.shift(offset);
      return clock;
    });
    const flow = await startEngineRuns(world, context.queueName, 5);
    const sleepers = await startEngineRuns(world, context.queueName, 2, {
      workflowType: "sleeper",
      input: () => ({ ms: 20_000 }),
      expected: () => ENGINE_RUN_RESULT,
    });
    const workload = mergeWorkloads(flow, sleepers);
    const engines = startEngines({
      pool: world.database.pool,
      queueName: context.queueName,
      count: offsets.length,
      concurrency: 2,
      visibilityTimeoutMs: 30_000,
      clocks,
      hooks: {
        onCheckpoint: async () => {
          await yieldRandomly(context.random);
          await pause(1 + Math.floor(context.random() * 8));
        },
      },
    });
    const converged = await settle(
      world,
      workload,
      whenStuck(world, workload, 3, async () => {
        clocks.forEach((clock) => {
          clock.shift(10_000);
        });
        await Promise.resolve();
      }),
    );
    await engines.stop();
    return {
      workload,
      converged,
      faults: offsets.filter((offset) => offset !== 0).length,
      survivedErrors: engines.errors.length,
    };
  },
};

const smallPool: ScenarioBody = {
  name: "small-pool",
  title: "Pool smaller than concurrency",
  injection:
    "Two engines each run six tasks at a time over a pool of two connections, so every task, heartbeat and loop tick competes for a connection. Sixteen runs must finish with no engine error that is not recovered.",
  fidelity:
    "Real connection pools with a real wait queue. The pressure is structural (six workers over two connections); the suite does not measure how long the waits last.",
  async run(world, context) {
    const poolErrors: Error[] = [];
    const pools = [0, 1].map(() =>
      createPool(process.env, {
        schema: world.database.schema,
        max: 2,
        onError: (error) => poolErrors.push(error),
      }),
    );
    const workload = await startEngineRuns(world, context.queueName, 16);
    const groups = pools.map((pool) =>
      startEngines({
        pool,
        queueName: context.queueName,
        count: 1,
        concurrency: 6,
        visibilityTimeoutMs: 30_000,
        hooks: { onCheckpoint: () => yieldRandomly(context.random) },
      }),
    );
    const converged = await settle(world, workload, () => Promise.resolve());
    await Promise.all(groups.map((group) => group.stop()));
    await Promise.all(pools.map((pool) => pool.end()));
    return {
      workload,
      converged,
      faults: pools.length * 4,
      survivedErrors:
        poolErrors.length + groups.reduce((total, group) => total + group.errors.length, 0),
    };
  },
};

const signalWait: ScenarioBody = {
  name: "signal-wait",
  title: "Runs waiting on a signal",
  injection:
    "Six runs park on a signal next to two ordinary runs. While they wait, the invariant checker must count them as waiting and not as stalled, and the clock moves forty minutes forward so the janitor sweeps again and again without recovering them. The signals then arrive in a random order and every run must complete with its payload.",
  fidelity:
    "Real engines and the real waiting marker of the decision loop. The wait lasts a few hundred real milliseconds and many virtual minutes; a run that waits for days is the same row for longer.",
  async run(world, context) {
    const clock = createShiftableClock();
    const pool = world.database.pool;
    const awaiters = await startEngineRuns(world, context.queueName, 6, {
      workflowType: "awaiter",
      input: () => ({}),
      expected: (index) => (index + 1) * 3,
    });
    const ordinary = await startEngineRuns(world, context.queueName, 2);
    const workload = mergeWorkloads(awaiters, ordinary);
    const engines = startEngines({
      pool,
      queueName: context.queueName,
      count: 2,
      concurrency: 2,
      visibilityTimeoutMs: 30_000,
      clock,
    });
    const violations: ChaosViolation[] = [];
    const parked = await until(async () => {
      const marked = await pool.query<{ parked: string }>(
        "select count(*) as parked from workflow_runs where id = any($1::uuid[]) and waiting_on = 'external'",
        [[...awaiters.runIds]],
      );
      return Number(marked.rows[0]?.parked) === awaiters.runIds.length;
    });
    if (!parked) {
      violations.push({
        check: "waiting-marker",
        runId: null,
        detail: "not every signal waiting run was marked as waiting",
      });
    }
    const whileWaiting = await world.checker.check({ runIds: awaiters.runIds });
    if (whileWaiting.violations.length > 0 || whileWaiting.waitingRuns !== awaiters.runIds.length) {
      violations.push({
        check: "waiting-not-stalled",
        runId: null,
        detail: `the checker saw ${String(whileWaiting.waitingRuns)} waiting runs and ${String(whileWaiting.violations.length)} violations among ${String(awaiters.runIds.length)} runs waiting on a signal`,
      });
    }
    let sweeps = 0;
    for (let sweep = 0; sweep < 4; sweep += 1) {
      clock.shift(10 * 60_000);
      sweeps += 1;
      await pause(60);
    }
    const recovered = await pool.query<{ open: string }>(
      "select count(*) as open from tasks where run_id = any($1::uuid[]) and state in ('PENDING', 'LEASED')",
      [[...awaiters.runIds]],
    );
    if (Number(recovered.rows[0]?.open) > 0) {
      violations.push({
        check: "waiting-run-left-alone",
        runId: null,
        detail: "the janitor created a task for a run that waits on a signal",
      });
    }
    const service = engineRunService(world, context.queueName);
    const order = awaiters.runIds
      .map((runId, index) => ({ runId, index, key: context.random() }))
      .sort((left, right) => left.key - right.key);
    for (const { runId, index } of order) {
      await service.signalRun(world.namespaceId, runId, "go", (index + 1) * 3);
    }
    const converged = await settle(
      world,
      workload,
      whenStuck(world, workload, 20, async () => {
        clock.shift(60_000);
        await Promise.resolve();
      }),
    );
    await engines.stop();
    return {
      workload,
      converged,
      faults: sweeps,
      survivedErrors: engines.errors.length,
      violations,
    };
  },
};

function createGate(): { promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Every scenario of the suite: the six original ones against the recorder
 * flow, then the same six and the five new ones against the engine runtime.
 */
export const SCENARIOS: readonly ChaosScenario[] = [
  ...[workerKill, dbConnectionLoss, doubleDelivery, clockShift, slowDisk, networkLatency].map(
    (body): ChaosScenario => ({ ...body, runtime: "recorder" }),
  ),
  ...[
    workerKill,
    dbConnectionLoss,
    doubleDelivery,
    clockShift,
    slowDisk,
    networkLatency,
    slowAttemptRace,
    twoQueues,
    clockSkew,
    smallPool,
    signalWait,
  ].map((body): ChaosScenario => ({ ...body, runtime: "engine" })),
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
  const seed =
    (scenario.runtime === "engine" ? ENGINE_SEED_OFFSET : 0) +
    (SCENARIO_NAMES.indexOf(scenario.name) + 1) * 1000 +
    repetition;
  const started = performance.now();
  const context: RepetitionContext = {
    repetition,
    seed,
    random: createSeededRandom(seed),
    queueName: `chaos/${scenario.runtime}-${scenario.name}-${String(repetition)}`,
    runtime: scenario.runtime,
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
      runtime: scenario.runtime,
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
      runtime: scenario.runtime,
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
