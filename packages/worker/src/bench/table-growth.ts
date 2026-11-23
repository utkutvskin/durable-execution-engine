import { defineStep, defineWorkflow, type Pool } from "@dee/core";
import { createRunService } from "../../../api/src/index.ts";
import { startEngine, type EngineRetentionOptions } from "../engine/runtime.ts";

/**
 * One reading of `measureTableGrowth`: how many runs had completed, how many
 * rows `tasks` and `task_history` held, and the on-disk size of `tasks` with
 * its indexes and toast.
 */
export interface TableGrowthSample {
  readonly elapsedMs: number;
  readonly runsCompleted: number;
  readonly taskRows: number;
  readonly taskBytes: number;
  readonly historyRows: number;
}

/**
 * Configuration of `measureTableGrowth`. The engine keeps `inFlight`
 * three-step runs going, starting one whenever one completes, until
 * `stopWhen` says to stop. A reading is taken each time `next` resolves; it
 * gets the number of runs completed so far. `sample` is called with each
 * reading, `retention` goes to the engine as is and `onError` receives the
 * errors the engine survives.
 */
export interface TableGrowthOptions {
  readonly pool: Pool;
  readonly namespaceId: string;
  readonly queueName: string;
  readonly inFlight: number;
  readonly retention: EngineRetentionOptions | false;
  readonly loopIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly stopWhen: (sample: TableGrowthSample) => boolean;
  readonly next: (runsCompleted: () => number) => Promise<void>;
  readonly sample?: (sample: TableGrowthSample) => void;
  readonly onError?: (error: unknown) => void;
}

async function readSample(
  pool: Pool,
  elapsedMs: number,
  runsCompleted: number,
): Promise<TableGrowthSample> {
  const result = await pool.query<{ task_rows: string; task_bytes: string; history_rows: string }>(
    `select (select count(*) from tasks) as task_rows,
            pg_total_relation_size('tasks') as task_bytes,
            (select count(*) from task_history) as history_rows`,
  );
  const row = result.rows[0];
  return {
    elapsedMs,
    runsCompleted,
    taskRows: Number(row?.task_rows),
    taskBytes: Number(row?.task_bytes),
    historyRows: Number(row?.history_rows),
  };
}

/**
 * Runs a steady workload on one engine and reads the size of `tasks` each
 * time `next` resolves, until `stopWhen` returns true. Returns every reading.
 */
export async function measureTableGrowth(
  options: TableGrowthOptions,
): Promise<readonly TableGrowthSample[]> {
  const step = defineStep<number, number>("grow-step", { handler: (value) => value + 1 });
  const workflow = defineWorkflow("grow", async (ctx, value: number) => {
    const first = await ctx.step<number>("grow-step", value);
    const second = await ctx.step<number>("grow-step", first);
    return ctx.step<number>("grow-step", second);
  });
  const service = createRunService(options.pool, { queueName: options.queueName });
  let runsCompleted = 0;
  let stopping = false;
  let starts: Promise<unknown> = Promise.resolve();
  const startOne = (): void => {
    starts = starts.then(() =>
      service.startRun(options.namespaceId, { workflowType: "grow", input: runsCompleted }),
    );
  };
  const engine = startEngine({
    pool: options.pool,
    queueName: options.queueName,
    workflows: [workflow],
    steps: [step],
    concurrency: 8,
    retention: options.retention,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.loopIntervalMs === undefined ? {} : { loopIntervalMs: options.loopIntervalMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    onDecision: (decision) => {
      if (decision.outcome === "completed") {
        runsCompleted += 1;
        if (!stopping) {
          startOne();
        }
      }
    },
  });
  const startedAt = Date.now();
  const samples: TableGrowthSample[] = [];
  try {
    for (let index = 0; index < options.inFlight; index += 1) {
      startOne();
    }
    await starts;
    for (;;) {
      await options.next(() => runsCompleted);
      const reading = await readSample(options.pool, Date.now() - startedAt, runsCompleted);
      samples.push(reading);
      options.sample?.(reading);
      if (options.stopWhen(reading)) {
        break;
      }
    }
  } finally {
    stopping = true;
    await starts.catch(() => undefined);
    await engine.stop();
  }
  return samples;
}
