import {
  ConcurrencyError,
  commandToEvent,
  createAttemptLog,
  createDeadLetterQueue,
  createPostgresEventStore,
  createResultRecorder,
  createRunCache,
  createStepTaskProcessor,
  createStickyDecider,
  enqueueStepTaskOnClient,
  isTerminalState,
  systemClock,
  systemRandomSource,
  withTransaction,
  type ClockSource,
  type EventStore,
  type LeasedTask,
  type LiveSession,
  type Pool,
  type RandomSource,
  type RunState,
  type StepDefinition,
  type StickyDecider,
  type TaskQueue,
  type TimeoutTimers,
  type Tracing,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowHandler,
} from "@dee/core";
import type { TaskHandler } from "../worker.js";

/**
 * A workflow definition of any input and result type, as the engine accepts
 * it.
 */
export type AnyWorkflowDefinition = WorkflowDefinition<never>;

/**
 * A step definition of any input and result type, as the engine accepts it.
 */
export type AnyStepDefinition = StepDefinition<never>;

/**
 * What `createEngineTaskHandler` needs. Workflow tasks and step tasks share
 * `queueName`. `buildId` is stamped on the patch markers a decision records.
 * `stepTimers` are the timers step timeouts use.
 */
export interface EngineTaskHandlerOptions {
  readonly pool: Pool;
  readonly queue: TaskQueue;
  readonly queueName: string;
  readonly workflows: readonly AnyWorkflowDefinition[];
  readonly steps: readonly AnyStepDefinition[];
  readonly buildId?: string;
  readonly clock?: ClockSource;
  readonly random?: RandomSource;
  readonly stepTimers?: TimeoutTimers;
  readonly tracing?: Tracing;
  readonly maxCachedRuns?: number;
  readonly stickyTimeoutMs?: number;
  readonly onDecision?: (decision: DecisionReport) => void;
}

/**
 * What one workflow task decided: the run, the outcome of the workflow code
 * and how many events the decision recorded.
 */
export interface DecisionReport {
  readonly runId: string;
  readonly workflowType: string;
  readonly outcome: string;
  readonly recordedEvents: number;
}

/**
 * Raised when a run's workflow type has no definition in the worker, so no
 * worker of this build can decide the run.
 */
export class UnknownWorkflowError extends Error {
  constructor(workflowType: string) {
    super(`no workflow registered for type "${workflowType}"`);
    this.name = "UnknownWorkflowError";
  }
}

interface RunRow {
  status: RunState;
  namespace_id: string;
}

const DEFAULT_MAX_CACHED_RUNS = 1000;
const DEFAULT_STICKY_TIMEOUT_MS = 60_000;

function openStepIds(events: readonly WorkflowEvent[]): WorkflowEvent[] {
  const finished = new Set<string>();
  for (const event of events) {
    if (event.type === "step_completed" || event.type === "step_failed") {
      finished.add(event.stepId);
    }
  }
  return events.filter((event) => event.type === "step_scheduled" && !finished.has(event.stepId));
}

/**
 * Builds the task handler of a worker that runs workflows end to end.
 *
 * A `WORKFLOW_TASK` replays the run's history through the workflow code
 * (through a per-process cache of live sessions), records the decision and
 * makes sure every scheduled step that has no result has a `STEP_TASK`. The
 * recorder already creates the step task in the transaction of the
 * `step_scheduled` event; the check on a suspended decision heals only step
 * tasks lost by other means, such as a task row removed by an operator. A
 * `STEP_TASK` runs the step with its retry policy and timeout, records the
 * result and enqueues a `WORKFLOW_TASK` so the run moves on. Tasks of closed
 * runs are acknowledged without effect, and redelivered tasks change
 * nothing. A workflow task that decided from a history another writer has
 * since extended records nothing and reports `superseded`: whoever wrote the
 * newer event also enqueued the task that sees it.
 */
export function createEngineTaskHandler(options: EngineTaskHandlerOptions): TaskHandler {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? systemRandomSource;
  const store: EventStore = createPostgresEventStore(options.pool);
  const recorder = createResultRecorder(options.pool, undefined, {
    queueName: options.queueName,
    clock,
    ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
  });
  const workflows = new Map(options.workflows.map((entry) => [entry.workflowType, entry]));
  const steps = new Map(
    options.steps.map((entry) => [entry.stepType, entry as unknown as StepDefinition]),
  );
  const decider: StickyDecider = createStickyDecider({
    cache: createRunCache<LiveSession>({
      maxRuns: options.maxCachedRuns ?? DEFAULT_MAX_CACHED_RUNS,
      stickyTimeoutMs: options.stickyTimeoutMs ?? DEFAULT_STICKY_TIMEOUT_MS,
      clock,
    }),
    decisionOptions: {
      clock,
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
    },
  });
  const processor = createStepTaskProcessor({
    pool: options.pool,
    queue: options.queue,
    recorder,
    attempts: createAttemptLog(options.pool),
    deadLetters: createDeadLetterQueue(options.pool),
    lookup: (stepType) => steps.get(stepType),
    clock,
    random,
    ...(options.stepTimers === undefined ? {} : { timers: options.stepTimers }),
    ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
  });

  async function readRun(runId: string): Promise<RunRow | undefined> {
    const result = await options.pool.query<RunRow>(
      "select status, namespace_id from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0];
  }

  async function ensureStepTasks(
    namespaceId: string,
    runId: string,
    events: readonly WorkflowEvent[],
  ): Promise<void> {
    const pending = openStepIds(events);
    if (pending.length === 0) {
      return;
    }
    await withTransaction(options.pool, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`steps:${runId}`]);
      for (const event of pending) {
        if (event.type !== "step_scheduled") {
          continue;
        }
        await enqueueStepTaskOnClient(client, {
          namespaceId,
          runId,
          queueName: options.queueName,
          stepId: event.stepId,
          stepType: event.stepType,
          input: event.input,
          now: clock.now(),
        });
      }
    });
  }

  async function handleWorkflowTask(task: LeasedTask): Promise<void> {
    const run = await readRun(task.runId);
    if (run === undefined || isTerminalState(run.status)) {
      decider.invalidate(task.runId);
      return;
    }
    const stored = await store.read(task.runId);
    const triggeredAt = stored.at(-1)?.createdAt;
    const history = stored.map((entry) => entry.event);
    const started = history[0];
    if (started?.type !== "run_started") {
      throw new Error(`run ${task.runId} does not start with run_started`);
    }
    const definition = workflows.get(started.workflowType);
    if (definition === undefined) {
      throw new UnknownWorkflowError(started.workflowType);
    }
    const { decision } = await decider.decide(
      task.runId,
      definition.handler as unknown as WorkflowHandler,
      started.input,
      history,
      triggeredAt,
    );
    const events = decision.commands.map(commandToEvent);
    let recorded;
    try {
      recorded = await recorder.recordWorkflowTaskResult({
        runId: task.runId,
        taskKey: task.id,
        expectedSeq: stored.at(-1)?.sequenceNumber ?? 0,
        events,
      });
    } catch (error) {
      decider.invalidate(task.runId);
      if (error instanceof ConcurrencyError) {
        options.onDecision?.({
          runId: task.runId,
          workflowType: started.workflowType,
          outcome: "superseded",
          recordedEvents: 0,
        });
        return;
      }
      throw error;
    }
    if (!recorded.recorded) {
      decider.invalidate(task.runId);
    }
    options.onDecision?.({
      runId: task.runId,
      workflowType: started.workflowType,
      outcome: decision.outcome,
      recordedEvents: recorded.recorded ? events.length : 0,
    });
    if (decision.outcome === "suspended") {
      await ensureStepTasks(run.namespace_id, task.runId, [...history, ...events]);
    }
  }

  async function handleStepTask(task: LeasedTask): Promise<void> {
    const outcome = await processor.process(task);
    if (
      outcome.status === "completed" ||
      outcome.status === "failed" ||
      outcome.status === "already_recorded"
    ) {
      await options.queue.enqueue({
        namespaceId: task.namespaceId,
        runId: task.runId,
        queueName: options.queueName,
        taskType: "WORKFLOW_TASK",
        payload: { reason: "step_completed" },
      });
    }
  }

  return async (task) => {
    if (task.taskType === "STEP_TASK") {
      await handleStepTask(task);
      return;
    }
    await handleWorkflowTask(task);
  };
}
