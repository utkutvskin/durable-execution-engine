import { performance } from "node:perf_hooks";
import { defineStep, defineWorkflow, type Pool } from "@dee/core";
import { createRunService } from "../../../api/src/index.ts";
import { startEngine } from "../engine/runtime.ts";
import { summarizeLatencies, type LatencySummary } from "./stats.ts";

/**
 * Configuration of `measureStartLatency`. Runs are started through
 * `producerPool`, which needs `notifyWakeups` for the engine's `wakeups` to
 * be woken; the engine itself uses `enginePool`. Before each sample the
 * engine is left alone for `idle()` to resolve, so its workers have backed
 * off to their longest poll wait.
 */
export interface StartLatencyOptions {
  readonly enginePool: Pool;
  readonly producerPool: Pool;
  readonly namespaceId: string;
  readonly queueName: string;
  readonly wakeups: boolean;
  readonly samples: number;
  readonly pollIntervalMs?: number;
  readonly idle?: () => Promise<void>;
}

/**
 * Measures the time from asking the run service to start a one-step run to
 * that step's handler starting, on an idle engine, and summarizes it. Each
 * sample waits for its run to complete before the next one starts.
 */
export async function measureStartLatency(options: StartLatencyOptions): Promise<LatencySummary> {
  let stepStarted: (() => void) | undefined;
  let runCompleted: (() => void) | undefined;
  const step = defineStep<number, number>("latency-step", {
    handler: (value) => {
      stepStarted?.();
      return Promise.resolve(value);
    },
  });
  const workflow = defineWorkflow("latency", (ctx, value: number) =>
    ctx.step("latency-step", value),
  );
  const engine = startEngine({
    pool: options.enginePool,
    queueName: options.queueName,
    workflows: [workflow],
    steps: [step],
    wakeups: options.wakeups,
    onDecision: (decision) => {
      if (decision.outcome === "completed") {
        runCompleted?.();
      }
    },
    loopIntervalMs: 3_600_000,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  const service = createRunService(options.producerPool, { queueName: options.queueName });
  const samples: number[] = [];
  try {
    for (let index = 0; index < options.samples; index += 1) {
      await options.idle?.();
      const reached = new Promise<number>((resolve) => {
        stepStarted = () => {
          resolve(performance.now());
        };
      });
      const completed = new Promise<void>((resolve) => {
        runCompleted = resolve;
      });
      const startedAt = performance.now();
      await service.startRun(options.namespaceId, { workflowType: "latency", input: index });
      samples.push((await reached) - startedAt);
      await completed;
    }
  } finally {
    await engine.stop();
  }
  return summarizeLatencies(samples);
}
