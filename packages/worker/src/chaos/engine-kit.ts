import { createRunService, type RunService } from "../../../api/src/index.js";
import { defineStep, defineWorkflow, type ClockSource, type Pool } from "@dee/core";
import { startEngine, type Engine } from "../engine/runtime.js";
import type {
  AnyStepDefinition,
  AnyWorkflowDefinition,
  DecisionReport,
} from "../engine/task-handler.js";
import type { ChaosWorld, Workload, WorkerGroup } from "./world.js";

/**
 * Behavior a scenario can attach to the workflows of the engine flow.
 * `onCheckpoint` runs at the start of every attempt of the `double` step and
 * may never resolve. `race` replaces the body of the `race` step, which is how
 * a scenario makes one attempt slow.
 */
export interface EngineFlowHooks {
  readonly onCheckpoint?: () => Promise<void>;
  readonly onDecision?: (decision: DecisionReport) => void;
  readonly race?: (attempt: number, value: number) => Promise<number>;
}

/**
 * The workflows and steps one chaos engine runs. `suffix` is appended to every
 * type name so two queues can serve different types.
 */
export interface EngineFlow {
  readonly workflows: readonly AnyWorkflowDefinition[];
  readonly steps: readonly AnyStepDefinition[];
}

/**
 * The result a sleeping run and a signalled run complete with.
 */
export const ENGINE_RUN_RESULT = 1;

/**
 * Builds the workflows of the engine chaos flow: `double` (one step that
 * doubles its input), `sleeper` (one durable sleep), `awaiter` (waits for the
 * signal `go` and completes with its payload) and `racer` (one step with
 * retries whose attempts a scenario can slow down).
 */
export function createEngineFlow(hooks: EngineFlowHooks = {}, suffix = ""): EngineFlow {
  const attempts = new Map<number, number>();
  const double = defineStep<{ value: number }, number>(`double${suffix}`, {
    handler: async ({ value }) => {
      await hooks.onCheckpoint?.();
      return value * 2;
    },
  });
  const race = defineStep<{ value: number }, number>(`race${suffix}`, {
    retry: { initialIntervalMs: 10, jitter: 0, maxAttempts: 5 },
    handler: async ({ value }) => {
      const attempt = (attempts.get(value) ?? 0) + 1;
      attempts.set(value, attempt);
      return hooks.race === undefined ? value * 2 : hooks.race(attempt, value);
    },
  });
  const doubler = defineWorkflow(`double${suffix}`, (ctx, input: { value: number }) =>
    ctx.step<number>(`double${suffix}`, input),
  );
  const racer = defineWorkflow(`racer${suffix}`, (ctx, input: { value: number }) =>
    ctx.step<number>(`race${suffix}`, input),
  );
  const sleeper = defineWorkflow(`sleeper${suffix}`, async (ctx, input: { ms: number }) => {
    await ctx.sleep(input.ms);
    return ENGINE_RUN_RESULT;
  });
  const awaiter = defineWorkflow(`awaiter${suffix}`, (ctx) => ctx.waitForSignal<number>("go"));
  return { workflows: [doubler, racer, sleeper, awaiter], steps: [double, race] };
}

/**
 * Tuning of `startEngines`.
 */
export interface EngineGroupOptions {
  readonly pool: Pool;
  readonly queueName: string;
  readonly count: number;
  readonly concurrency: number;
  readonly visibilityTimeoutMs: number;
  readonly clock?: ClockSource;
  readonly clocks?: readonly ClockSource[];
  readonly hooks?: EngineFlowHooks;
  readonly suffix?: string;
  readonly stalledRunGraceMs?: number;
}

/**
 * Starts `count` engines on `queueName`, each with its own flow instance, and
 * returns them as a worker group. Errors the engines survive are collected.
 */
export function startEngines(options: EngineGroupOptions): WorkerGroup & {
  readonly engines: readonly Engine[];
} {
  const errors: unknown[] = [];
  const engines = Array.from({ length: options.count }, (_, index) => {
    const flow = createEngineFlow(options.hooks, options.suffix);
    const clock = options.clocks?.[index] ?? options.clock;
    return startEngine({
      pool: options.pool,
      queueName: options.queueName,
      workflows: flow.workflows,
      steps: flow.steps,
      concurrency: options.concurrency,
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      visibilityTimeoutMs: options.visibilityTimeoutMs,
      stalledRunGraceMs: options.stalledRunGraceMs ?? 60_000,
      shutdownTimeoutMs: 2_000,
      nackBackoff: { initialMs: 5, maxMs: 50 },
      poisonThreshold: 50,
      stickyTimeoutMs: 500,
      buildId: `chaos-${String(index)}`,
      ...(clock === undefined ? {} : { clock }),
      ...(options.hooks?.onDecision === undefined ? {} : { onDecision: options.hooks.onDecision }),
      onError: (error) => {
        errors.push(error);
      },
    });
  });
  return {
    errors,
    engines,
    async stop(): Promise<void> {
      await Promise.all(engines.map((engine) => engine.stop()));
    },
  };
}

/**
 * What `startEngineRuns` starts.
 */
export interface EngineRunsOptions {
  readonly workflowType?: string;
  readonly input?: (index: number) => unknown;
  readonly expected?: (index: number) => number;
}

/**
 * Starts `count` runs through the run service, the way the API does, on
 * `queueName`. Run `index` of the default workflow doubles `index + 1`.
 */
export async function startEngineRuns(
  world: ChaosWorld,
  queueName: string,
  count: number,
  options: EngineRunsOptions = {},
): Promise<Workload> {
  const service: RunService = createRunService(world.database.pool, { queueName });
  const workflowType = options.workflowType ?? "double";
  const input = options.input ?? ((index: number): unknown => ({ value: index + 1 }));
  const expected = options.expected ?? ((index: number): number => (index + 1) * 2);
  const runIds: string[] = [];
  const expectedResults = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const started = await service.startRun(world.namespaceId, {
      workflowType,
      input: input(index),
    });
    runIds.push(started.run.runId);
    expectedResults.set(started.run.runId, expected(index));
  }
  const tasks = await world.database.pool.query<{ id: string }>(
    "select id from tasks where run_id = any($1::uuid[]) order by id",
    [runIds],
  );
  return { runIds, taskIds: tasks.rows.map((row) => row.id), expectedResults };
}

/**
 * Returns the run service the engine chaos scenarios use to send signals.
 */
export function engineRunService(world: ChaosWorld, queueName: string): RunService {
  return createRunService(world.database.pool, { queueName });
}
