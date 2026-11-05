import type { Pool } from "pg";
import { z } from "zod";
import { noopTracing, type TraceSpan, type Tracing } from "../observability/tracing.js";
import type { ResultRecorder } from "../idempotency/recorder.js";
import type { LeasedTask, TaskQueue } from "../queue/task-queue.js";
import type { StepDefinition } from "../workflow/define-step.js";
import { serializeError } from "../workflow/error-serialization.js";
import {
  systemClock,
  systemRandomSource,
  type ClockSource,
  type RandomSource,
} from "../workflow/sources.js";
import type { AttemptLog } from "./attempt-log.js";
import type { DeadLetterQueue } from "./dead-letters.js";
import {
  DEFAULT_RETRY_POLICY,
  NonRetryableError,
  decideRetry,
  type RetryPolicy,
} from "./retry-policy.js";
import { runWithTimeout, type TimeoutTimers } from "./timeout.js";

const stepTaskPayloadSchema = z.object({
  stepId: z.string().min(1),
  stepType: z.string().min(1),
  input: z.unknown(),
  attemptOffset: z.number().int().nonnegative().default(0),
});

/**
 * The payload of a `STEP_TASK`: which step of the run to execute, with what
 * input. `attemptOffset` is the number of attempts already used before the
 * task's current retry budget began (non-zero after a dead letter requeue).
 */
export type StepTaskPayload = z.input<typeof stepTaskPayloadSchema>;

/**
 * What became of one delivery of a step task.
 */
export type StepTaskOutcome =
  | { readonly status: "completed"; readonly attempt: number }
  | {
      readonly status: "retry_scheduled";
      readonly attempt: number;
      readonly delayMs: number;
      readonly retryAt: Date;
    }
  | { readonly status: "failed"; readonly attempt: number }
  | { readonly status: "dead_lettered"; readonly attempt: number; readonly deadLetterId: string }
  | { readonly status: "already_recorded" }
  | { readonly status: "lease_lost" };

/**
 * Everything `createStepTaskProcessor` works with. `lookup` finds a step by
 * its type; `clock`, `random` and `timers` default to the real ones. With
 * `tracing`, each executed attempt emits a `step` span under the run's stored
 * `traceparent`; a delivery whose result is already recorded emits none.
 */
export interface StepTaskProcessorOptions {
  readonly pool: Pool;
  readonly queue: TaskQueue;
  readonly recorder: ResultRecorder;
  readonly attempts: AttemptLog;
  readonly deadLetters: DeadLetterQueue;
  readonly lookup: (stepType: string) => StepDefinition | undefined;
  readonly clock?: ClockSource;
  readonly random?: RandomSource;
  readonly timers?: TimeoutTimers;
  readonly tracing?: Tracing;
}

/**
 * Runs the steps `STEP_TASK`s ask for, applying each step's retry policy and
 * timeout.
 */
export interface StepTaskProcessor {
  /**
   * Handles one delivery of a step task.
   *
   * A success is recorded as `step_completed` and the task acked. A failure
   * is written to the event log as `step_attempt_failed`; then, by the
   * step's `RetryPolicy`, the task is nacked with the backoff delay, or the
   * step is given up on. A `NonRetryableError` ends the step with
   * `step_failed` so the workflow sees the failure. Exhausting the attempts
   * parks the step in the dead letter queue for the operator and records
   * `step_failed` with `exhausted`, in one transaction, so the workflow sees
   * a `StepFailedError` it can catch. A requeued dead letter runs the step
   * again, but its result is not recorded when the step already has one. A step with a recorded result is
   * acked without running again. The recorder, under the run's lock, is what
   * guarantees one terminal result per step: an attempt that finishes after
   * another attempt recorded its result changes nothing and reports
   * `already_recorded`.
   */
  process(task: LeasedTask, context?: StepTaskContext): Promise<StepTaskOutcome>;
}

/**
 * What the caller of `StepTaskProcessor.process` can tell it about the
 * delivery. `signal` aborts when the task's lease is lost or the worker drops
 * it. The step handler receives it, combined with its own timeout, and an
 * aborted delivery reports `lease_lost` without recording an attempt, an ack
 * or a nack: the step's next delivery decides what happens.
 */
export interface StepTaskContext {
  readonly signal?: AbortSignal;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

function rejectOnAbort(signal: AbortSignal | undefined): {
  readonly promise: Promise<never>;
  dispose(): void;
} {
  if (signal === undefined) {
    return { promise: new Promise<never>(() => undefined), dispose: () => undefined };
  }
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    listener = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  promise.catch(() => undefined);
  return {
    promise,
    dispose(): void {
      if (listener !== undefined) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

const systemTimers: TimeoutTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Creates a `StepTaskProcessor`. Attempt numbers continue across redeliveries
 * and requeues because they come from the `AttemptLog`, not from the queue's
 * delivery count, so a crash redelivery does not use up a retry.
 */
export function createStepTaskProcessor(options: StepTaskProcessorOptions): StepTaskProcessor {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? systemRandomSource;
  const timers = options.timers ?? systemTimers;
  const tracing = options.tracing ?? noopTracing;

  async function readTraceparent(runId: string): Promise<string | null> {
    const result = await options.pool.query<{ traceparent: string | null }>(
      "select traceparent from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.traceparent ?? null;
  }

  async function hasRecordedResult(runId: string, stepId: string): Promise<boolean> {
    const result = await options.pool.query(
      "select 1 from step_results where run_id = $1 and step_id = $2 limit 1",
      [runId, stepId],
    );
    return result.rowCount !== 0;
  }

  async function executeTraced(
    definition: StepDefinition | undefined,
    stepType: string,
    input: unknown,
    span: TraceSpan,
    leaseSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    const abortion = rejectOnAbort(leaseSignal);
    try {
      if (definition === undefined) {
        throw new NonRetryableError(`no step registered for type "${stepType}"`);
      }
      const run = runWithTimeout(
        (timeoutSignal) =>
          definition.handler(input, {
            signal:
              leaseSignal === undefined
                ? timeoutSignal
                : AbortSignal.any([timeoutSignal, leaseSignal]),
          }),
        definition.timeoutMs,
        timers,
      );
      return await Promise.race([run, abortion.promise]);
    } catch (thrown) {
      span.recordError(thrown);
      throw thrown;
    } finally {
      abortion.dispose();
      span.end();
    }
  }

  return {
    async process(task: LeasedTask, context: StepTaskContext = {}): Promise<StepTaskOutcome> {
      const payload = stepTaskPayloadSchema.parse(task.payload);
      const { runId } = task;
      const { stepId } = payload;

      if (isAborted(context.signal)) {
        return { status: "lease_lost" };
      }
      if (await hasRecordedResult(runId, stepId)) {
        await options.queue.ack(task.id, task.leaseToken);
        return { status: "already_recorded" };
      }

      const attempt = await options.attempts.nextAttempt(runId, stepId);
      const definition = options.lookup(payload.stepType);
      const policy: RetryPolicy = definition?.retry ?? DEFAULT_RETRY_POLICY;
      const span = tracing.startSpan(`step ${payload.stepType}`, {
        parent: await readTraceparent(runId),
        attributes: {
          "dee.run.id": runId,
          "dee.step.id": stepId,
          "dee.step.type": payload.stepType,
          "dee.step.attempt": attempt,
        },
      });

      try {
        const result = await executeTraced(
          definition,
          payload.stepType,
          payload.input,
          span,
          context.signal,
        );
        const recorded = await options.recorder.recordStepResult({
          runId,
          stepId,
          attemptKey: `attempt-${String(attempt)}`,
          outcome: { status: "completed", result },
        });
        const acked = await options.queue.ack(task.id, task.leaseToken);
        if (!acked) {
          return { status: "lease_lost" };
        }
        return recorded.recorded
          ? { status: "completed", attempt }
          : { status: "already_recorded" };
      } catch (thrown) {
        if (isAborted(context.signal)) {
          return { status: "lease_lost" };
        }
        const error = serializeError(thrown);
        const decision = decideRetry(policy, attempt - payload.attemptOffset, error, random);

        if (decision.retry) {
          const retryAt = new Date(clock.now().getTime() + decision.delayMs);
          await options.attempts.recordFailure({ runId, stepId, attempt, error, retryAt });
          const nacked = await options.queue.nack(task.id, task.leaseToken, decision.delayMs);
          return nacked
            ? { status: "retry_scheduled", attempt, delayMs: decision.delayMs, retryAt }
            : { status: "lease_lost" };
        }

        await options.attempts.recordFailure({ runId, stepId, attempt, error, retryAt: null });
        if (decision.reason === "NON_RETRYABLE") {
          const recorded = await options.recorder.recordStepResult({
            runId,
            stepId,
            attemptKey: `attempt-${String(attempt)}`,
            outcome: { status: "failed", error },
          });
          await options.queue.ack(task.id, task.leaseToken);
          return recorded.recorded ? { status: "failed", attempt } : { status: "already_recorded" };
        }
        const deadLetterId = await options.deadLetters.addAndAck(
          {
            namespaceId: task.namespaceId,
            runId,
            stepId,
            queueName: task.queueName,
            payload: task.payload,
            attempts: attempt,
            error,
            reason: "MAX_ATTEMPTS_EXHAUSTED",
          },
          { taskId: task.id, leaseToken: task.leaseToken },
          async (client) => {
            await options.recorder.recordStepResult(
              {
                runId,
                stepId,
                attemptKey: `attempt-${String(attempt)}`,
                outcome: { status: "failed", error, exhausted: true },
              },
              client,
            );
          },
        );
        if (deadLetterId === undefined) {
          return { status: "lease_lost" };
        }
        return { status: "dead_lettered", attempt, deadLetterId };
      }
    },
  };
}
