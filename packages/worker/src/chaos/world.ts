import {
  createInvariantChecker,
  createPostgresEventStore,
  createResultRecorder,
  createTaskQueue,
  resolveDatabaseUrl,
  type ClockSource,
  type EventStore,
  type InvariantChecker,
  type InvariantViolation,
  type LeasedTask,
  type Pool,
} from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { createWorkerIdentity } from "../identity.js";
import { createWorker, type TaskHandler, type Worker } from "../worker.js";
import { createFlowHandler } from "./flow.js";

/**
 * One violation found by a chaos repetition: either a broken engine
 * invariant or a workload that did not converge to its expected result.
 */
export interface ChaosViolation {
  readonly check: string;
  readonly runId: string | null;
  readonly detail: string;
}

/**
 * The database a scenario works in, with the event store and the invariant
 * checker over it.
 */
export interface ChaosWorld {
  readonly database: IsolatedSchema;
  readonly store: EventStore;
  readonly checker: InvariantChecker;
  readonly namespaceId: string;
}

/**
 * Creates a migrated, isolated schema with one namespace.
 */
export async function createChaosWorld(): Promise<ChaosWorld> {
  const database = await createIsolatedDatabase();
  const namespace = await database.pool.query<{ id: string }>(
    "insert into namespaces (name) values ('chaos') returning id",
  );
  return {
    database,
    store: createPostgresEventStore(database.pool),
    checker: createInvariantChecker(database.pool, createPostgresEventStore(database.pool)),
    namespaceId: namespace.rows[0]?.id ?? "",
  };
}

/**
 * A clock that can be moved forward and backward by hand on top of the
 * system clock.
 */
export interface ShiftableClock extends ClockSource {
  shift(ms: number): void;
}

/**
 * Creates a `ShiftableClock` that starts at the system time.
 */
export function createShiftableClock(): ShiftableClock {
  let offsetMs = 0;
  return {
    now: () => new Date(Date.now() + offsetMs),
    shift(ms: number): void {
      offsetMs += ms;
    },
  };
}

/**
 * The runs and tasks a scenario created, with the result each run must end
 * with.
 */
export interface Workload {
  readonly runIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly expectedResults: ReadonlyMap<string, number>;
}

/**
 * Starts `count` runs of the sample flow, each with one pending step task on
 * `queueName`. Run `index` doubles `index + 1`.
 */
export async function startFlowRuns(
  world: ChaosWorld,
  queueName: string,
  count: number,
  clock?: ClockSource,
): Promise<Workload> {
  const queue = createTaskQueue(world.database.pool, clock === undefined ? {} : { clock });
  const runIds: string[] = [];
  const taskIds: string[] = [];
  const expectedResults = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const value = index + 1;
    const run = await world.database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'double') returning id",
      [world.namespaceId],
    );
    const runId = run.rows[0]?.id ?? "";
    await world.store.append(runId, 0, [
      { type: "run_started", workflowType: "double", input: { value } },
      { type: "step_scheduled", stepId: "step-1", stepType: "double", input: { value } },
    ]);
    taskIds.push(
      await queue.enqueue({
        namespaceId: world.namespaceId,
        runId,
        queueName,
        taskType: "STEP_TASK",
        payload: { stepId: "step-1", value },
      }),
    );
    runIds.push(runId);
    expectedResults.set(runId, value * 2);
  }
  return { runIds, taskIds, expectedResults };
}

/**
 * Merges workloads into one.
 */
export function mergeWorkloads(...workloads: readonly Workload[]): Workload {
  return {
    runIds: workloads.flatMap((workload) => workload.runIds),
    taskIds: workloads.flatMap((workload) => workload.taskIds),
    expectedResults: new Map(workloads.flatMap((workload) => [...workload.expectedResults])),
  };
}

/**
 * The result a timer driven run completes with.
 */
export const TIMER_RUN_RESULT = 1;

/**
 * The handler of a timer driven run: the `timer_fired` workflow task
 * completes the run with `TIMER_RUN_RESULT`.
 */
export function createTimerRunHandler(pool: Pool, store: EventStore): TaskHandler {
  const recorder = createResultRecorder(pool);
  return async (task: LeasedTask): Promise<void> => {
    const history = await store.read(task.runId);
    const payload = task.payload as { timerId?: string };
    await recorder.recordWorkflowTaskResult({
      runId: task.runId,
      taskKey: `timer-${payload.timerId ?? "unknown"}`,
      expectedSeq: history.at(-1)?.sequenceNumber ?? 0,
      events: [{ type: "run_completed", result: TIMER_RUN_RESULT }],
    });
  };
}

/**
 * Routes a task to the flow handler or the timer run handler by its type.
 */
export function createChaosHandler(flow: TaskHandler, timerRun: TaskHandler): TaskHandler {
  return (task, context) =>
    task.taskType === "STEP_TASK" ? flow(task, context) : timerRun(task, context);
}

/**
 * Tuning of `startWorkers`.
 */
export interface WorkerGroupOptions {
  readonly pool: Pool;
  readonly store: EventStore;
  readonly queueName: string;
  readonly count: number;
  readonly concurrency: number;
  readonly visibilityTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly clock?: ClockSource;
  readonly onCheckpoint?: Parameters<typeof createFlowHandler>[0]["onCheckpoint"];
}

/**
 * A group of workers started together.
 */
export interface WorkerGroup {
  /** Errors the workers survived, such as a poll that lost its connection. */
  readonly errors: readonly unknown[];
  stop(): Promise<void>;
}

/**
 * Starts `count` workers that run the sample flow against `queueName`.
 */
export function startWorkers(options: WorkerGroupOptions): WorkerGroup {
  const errors: unknown[] = [];
  const workers: Worker[] = Array.from({ length: options.count }, (_, index) =>
    createWorker({
      queue: createTaskQueue(
        options.pool,
        options.clock === undefined ? {} : { clock: options.clock },
      ),
      queueName: options.queueName,
      concurrency: options.concurrency,
      pollIntervalMs: 5,
      maxPollIntervalMs: 25,
      visibilityTimeoutMs: options.visibilityTimeoutMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      shutdownTimeoutMs: 2_000,
      identity: createWorkerIdentity({ version: `chaos-${String(index)}` }),
      onError: (error) => {
        errors.push(error);
      },
      handler: createFlowHandler({
        pool: options.pool,
        store: options.store,
        ...(options.onCheckpoint === undefined ? {} : { onCheckpoint: options.onCheckpoint }),
      }),
    }),
  );
  workers.forEach((worker) => {
    worker.start();
  });
  return {
    errors,
    async stop(): Promise<void> {
      await Promise.all(workers.map((worker) => worker.stop()));
    },
  };
}

const SETTLE_DEADLINE_MS = 60_000;

/**
 * Waits until every run of `workload` is terminal. Each time the workload has
 * not moved, `onStuck` is called, which is where a scenario moves its clock
 * or runs its janitor. Resolves `false` when the deadline passes first.
 */
export async function settle(
  world: ChaosWorld,
  workload: Workload,
  onStuck: () => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (Date.now() < deadline) {
    const open = await world.database.pool.query<{ open: string }>(
      "select count(*) as open from workflow_runs where id = any($1::uuid[]) and status = 'RUNNING'",
      [[...workload.runIds]],
    );
    if (Number(open.rows[0]?.open) === 0) {
      return true;
    }
    await onStuck();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function toChaosViolation(violation: InvariantViolation): ChaosViolation {
  return {
    check: violation.invariant,
    runId: violation.runId,
    detail:
      violation.taskId === null
        ? violation.detail
        : `${violation.detail} (task ${violation.taskId})`,
  };
}

/**
 * Checks a finished workload: every run completed with its expected result
 * and no engine invariant is broken. Returns the violations found.
 */
export async function verifyWorkload(
  world: ChaosWorld,
  workload: Workload,
  converged: boolean,
): Promise<{ violations: ChaosViolation[]; runsChecked: number; tasksChecked: number }> {
  const violations: ChaosViolation[] = [];
  if (!converged) {
    violations.push({
      check: "workload-converged",
      runId: null,
      detail: "not every run reached a terminal state before the deadline",
    });
  }
  const rows = await world.database.pool.query<{ id: string; status: string; result: unknown }>(
    "select id, status, result from workflow_runs where id = any($1::uuid[])",
    [[...workload.runIds]],
  );
  for (const row of rows.rows) {
    const expected = workload.expectedResults.get(row.id);
    if (row.status === "RUNNING") {
      continue;
    }
    if (row.status !== "COMPLETED" || row.result !== expected) {
      violations.push({
        check: "workload-result",
        runId: row.id,
        detail: `run ended ${row.status} with result ${JSON.stringify(row.result)}, expected COMPLETED with ${String(expected)}`,
      });
    }
  }
  const report = await world.checker.check({
    runIds: workload.runIds,
    expectedTaskIds: workload.taskIds,
  });
  violations.push(...report.violations.map(toChaosViolation));
  return { violations, runsChecked: report.runsChecked, tasksChecked: report.tasksChecked };
}

/**
 * Where the test database listens, read from the same environment
 * `createPool` reads.
 */
export function databaseTarget(): {
  readonly host: string;
  readonly port: number;
  readonly url: URL;
} {
  const url = new URL(resolveDatabaseUrl(process.env));
  return { host: url.hostname, port: Number(url.port === "" ? "5432" : url.port), url };
}

/**
 * The environment a pool needs to reach the database through `proxyPort`.
 */
export function proxiedEnv(proxyPort: number): { DATABASE_URL: string } {
  const url = databaseTarget().url;
  url.hostname = "127.0.0.1";
  url.port = String(proxyPort);
  return { DATABASE_URL: url.toString() };
}

/**
 * Builds a function for `settle` that calls `action` once the workload has
 * made no progress (no new event and no acked task) for `patience` calls in a
 * row. A scenario uses it to move its clock only when the system is truly
 * waiting on an expired lease.
 */
export function whenStuck(
  world: ChaosWorld,
  workload: Workload,
  patience: number,
  action: () => Promise<void>,
): () => Promise<void> {
  let lastProgress = -1;
  let idleCalls = 0;
  return async (): Promise<void> => {
    const result = await world.database.pool.query<{ progress: string }>(
      `select (select count(*) from run_events where run_id = any($1::uuid[]))
            + (select count(*) from tasks where state = 'COMPLETED' and run_id = any($1::uuid[]))
              as progress`,
      [[...workload.runIds]],
    );
    const progress = Number(result.rows[0]?.progress);
    if (progress !== lastProgress) {
      lastProgress = progress;
      idleCalls = 0;
      return;
    }
    idleCalls += 1;
    if (idleCalls >= patience) {
      idleCalls = 0;
      await action();
    }
  };
}
