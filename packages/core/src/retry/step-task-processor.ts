import type { Pool } from "pg";
import { z } from "zod";
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
 * its type; `clock`, `random` and `timers` default to the real ones.
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
   * parks the step in the dead letter queue and leaves the run waiting on
   * it, to be requeued by an operator. A step with a recorded result is
   * acked without running again.
   */
  process(task: LeasedTask): Promise<StepTaskOutcome>;
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

  async function hasRecordedResult(runId: string, stepId: string): Promise<boolean> {
    const result = await options.pool.query(
      "select 1 from step_results where run_id = $1 and step_id = $2 limit 1",
      [runId, stepId],
    );
    return result.rowCount !== 0;
  }

  return {
    async process(task: LeasedTask): Promise<StepTaskOutcome> {
      const payload = stepTaskPayloadSchema.parse(task.payload);
      const { runId } = task;
      const { stepId } = payload;

      if (await hasRecordedResult(runId, stepId)) {
        await options.queue.ack(task.id, task.leaseToken);
        return { status: "already_recorded" };
      }

      const attempt = await options.attempts.nextAttempt(runId, stepId);
      const definition = options.lookup(payload.stepType);
      const policy: RetryPolicy = definition?.retry ?? DEFAULT_RETRY_POLICY;

      try {
        if (definition === undefined) {
          throw new NonRetryableError(`no step registered for type "${payload.stepType}"`);
        }
        const result = await runWithTimeout(
          () => definition.handler(payload.input),
          definition.timeoutMs,
          timers,
        );
        await options.recorder.recordStepResult({
          runId,
          stepId,
          attemptKey: `attempt-${String(attempt)}`,
          outcome: { status: "completed", result },
        });
        const acked = await options.queue.ack(task.id, task.leaseToken);
        return acked ? { status: "completed", attempt } : { status: "lease_lost" };
      } catch (thrown) {
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
          await options.recorder.recordStepResult({
            runId,
            stepId,
            attemptKey: `attempt-${String(attempt)}`,
            outcome: { status: "failed", error },
          });
          await options.queue.ack(task.id, task.leaseToken);
          return { status: "failed", attempt };
        }
        const deadLetterId = await options.deadLetters.add({
          namespaceId: task.namespaceId,
          runId,
          stepId,
          queueName: task.queueName,
          payload: task.payload,
          attempts: attempt,
          error,
          reason: "MAX_ATTEMPTS_EXHAUSTED",
        });
        await options.queue.ack(task.id, task.leaseToken);
        return { status: "dead_lettered", attempt, deadLetterId };
      }
    },
  };
}
