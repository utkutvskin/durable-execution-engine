import {
  createResultRecorder,
  refreshProjection,
  type Pool,
  type EventStore,
  type LeasedTask,
} from "@dee/core";
import type { TaskHandler } from "../worker.js";

/**
 * The points of the sample flow where a chaos child can be told to hang so
 * the harness can kill it there. `before-record` is mid-step, `after-record`
 * is after the step result is stored but before the run is finished, and
 * `after-finish` is after the run completed but before the task was acked.
 */
export const CRASH_POINTS = ["before-record", "after-record", "after-finish"] as const;

/**
 * One of the values of `CRASH_POINTS`.
 */
export type CrashPoint = (typeof CRASH_POINTS)[number];

/**
 * The payload of a task of the sample flow: a single step that doubles
 * `value`, after which the run completes with the doubled value.
 */
export interface FlowTaskPayload {
  readonly stepId: string;
  readonly value: number;
}

/**
 * What `createFlowHandler` needs. `onCheckpoint` is called at every crash
 * point and may never resolve, which is how a child parks itself until it is
 * killed.
 */
export interface FlowHandlerOptions {
  readonly pool: Pool;
  readonly store: EventStore;
  readonly onCheckpoint?: (point: CrashPoint, task: LeasedTask) => Promise<void>;
}

function readPayload(task: LeasedTask): FlowTaskPayload {
  const payload = task.payload as Partial<FlowTaskPayload>;
  if (typeof payload.stepId !== "string" || typeof payload.value !== "number") {
    throw new TypeError(`task ${task.id} has no flow payload`);
  }
  return { stepId: payload.stepId, value: payload.value };
}

/**
 * Builds the task handler of the sample flow used by the crash recovery
 * tests. It computes the step result, records it exactly once, completes the
 * run exactly once and refreshes the run projection, so running it again for
 * a redelivered task changes nothing.
 */
export function createFlowHandler(options: FlowHandlerOptions): TaskHandler {
  const recorder = createResultRecorder(options.pool);
  const checkpoint = options.onCheckpoint ?? ((): Promise<void> => Promise.resolve());

  return async (task) => {
    const { stepId, value } = readPayload(task);
    await checkpoint("before-record", task);
    const recorded = await recorder.recordStepResult({
      runId: task.runId,
      stepId,
      attemptKey: `${stepId}#1`,
      outcome: { status: "completed", result: value * 2 },
    });
    await checkpoint("after-record", task);
    const history = await options.store.read(task.runId);
    const expectedSeq = history.at(-1)?.sequenceNumber ?? 0;
    const outcome = recorded.outcome;
    await recorder.recordWorkflowTaskResult({
      runId: task.runId,
      taskKey: "finish",
      expectedSeq,
      events: [
        {
          type: "run_completed",
          result: outcome.status === "completed" ? outcome.result : null,
        },
      ],
    });
    await refreshProjection(options.pool, options.store, task.runId);
    await checkpoint("after-finish", task);
  };
}
