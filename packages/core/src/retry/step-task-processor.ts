import type { Pool } from "pg";
import { identityPayloadCodec, type PayloadCodec } from "../codec/payload-codec.ts";
import { z } from "zod";
import { noopTracing, type TraceSpan, type Tracing } from "../observability/tracing.ts";
import type { RecordStepResultInput, ResultRecorder } from "../idempotency/recorder.ts";
import type { LeasedTask, TaskQueue } from "../queue/task-queue.ts";
import type { StepDefinition } from "../workflow/define-step.ts";
import { serializeError, type SerializedError } from "../workflow/error-serialization.ts";
import {
  systemClock,
  systemRandomSource,
  type ClockSource,
  type RandomSource,
} from "../workflow/sources.ts";
import { StepScheduleToCloseTimeoutError } from "../workflow/errors.ts";
import type { StepContext } from "../workflow/step-registry.ts";
import type { AttemptLog } from "./attempt-log.ts";
import type { DeadLetterQueue } from "./dead-letters.ts";
import { createHeartbeatStore, type HeartbeatStore } from "./heartbeats.ts";
import {
  DEFAULT_RETRY_POLICY,
  NonRetryableError,
  decideRetry,
  type RetryPolicy,
} from "./retry-policy.ts";
import {
  StepHeartbeatTimeoutError,
  StepTimeoutError,
  runWithDeadlines,
  type Deadline,
  type TimeoutTimers,
} from "./timeout.ts";

const stepTaskPayloadSchema = z.object({
  stepId: z.string().min(1),
  stepType: z.string().min(1),
  input: z.unknown(),
  attemptOffset: z.number().int().nonnegative().default(0),
  scheduledAt: z.iso.datetime().optional(),
});

/**
 * The payload of a `STEP_TASK`: which step of the run to execute, with what
 * input. `attemptOffset` is the number of attempts already used before the
 * task's current retry budget began (non-zero after a dead letter requeue).
 * `scheduledAt` is when the step was scheduled (or requeued), which its
 * schedule-to-close timeout counts from; a task without it has no
 * schedule-to-close deadline.
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
 * `heartbeats` defaults to a `HeartbeatStore` over `pool`. `beforeSettle`
 * runs once a completed, failed or already recorded outcome is stored and
 * before the task is acked, which is where a worker enqueues the run's next
 * workflow task so the run never stands without an open task.
 *
 * `followUp` replaces `beforeSettle` and the separate ack: the result, the
 * run's next `WORKFLOW_TASK` on `followUp.queueName` and the ack are written
 * in one statement (see `ResultRecorder.completeStepTask`). Its `clock`
 * stamps the task rows, the database's time is used without it.
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
  readonly heartbeats?: HeartbeatStore;
  readonly beforeSettle?: (task: LeasedTask) => Promise<void>;
  readonly followUp?: StepFollowUp;
  /**
   * Decodes the step input before the handler sees it and encodes the
   * result before it is recorded. Defaults to `identityPayloadCodec`.
   */
  readonly payloadCodec?: PayloadCodec;
}

/**
 * Where `StepTaskProcessorOptions.followUp` enqueues a run's next workflow
 * task once a step task is settled.
 */
export interface StepFollowUp {
  readonly queueName: string;
  readonly clock?: ClockSource;
}

/**
 * Runs the steps `STEP_TASK`s ask for, applying each step's retry policy and
 * timeout.
 */
export interface StepTaskProcessor {
  /**
   * Handles one delivery of a step task.
   *
   * The step's timeouts apply to every attempt: `timeoutMs` (start to
   * close) and `heartbeatTimeoutMs` fail the attempt with a retryable
   * `StepTimeoutError` or `StepHeartbeatTimeoutError`. When the
   * schedule-to-close deadline passes, during an attempt, before one starts,
   * or because the next retry would start after it, the step ends with
   * `step_failed` carrying a `StepScheduleToCloseTimeoutError`. The handler
   * receives the details of the step's last heartbeat; heartbeats still
   * being stored when an attempt fails are written before the failure is
   * recorded, so the next attempt sees them.
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
  const payloadCodec = options.payloadCodec ?? identityPayloadCodec;
  const random = options.random ?? systemRandomSource;
  const timers = options.timers ?? systemTimers;
  const tracing = options.tracing ?? noopTracing;
  const heartbeats = options.heartbeats ?? createHeartbeatStore(options.pool);

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

  function attemptDeadlines(
    definition: StepDefinition,
    scheduleDeadline: Date | undefined,
  ): { fixed: Deadline[]; heartbeat?: Deadline } {
    const fixed: Deadline[] = [];
    const { timeoutMs, heartbeatTimeoutMs, scheduleToCloseTimeoutMs } = definition;
    if (timeoutMs !== undefined) {
      fixed.push({ delayMs: timeoutMs, error: () => new StepTimeoutError(timeoutMs) });
    }
    if (scheduleDeadline !== undefined && scheduleToCloseTimeoutMs !== undefined) {
      fixed.push({
        delayMs: Math.max(0, scheduleDeadline.getTime() - clock.now().getTime()),
        error: () => new StepScheduleToCloseTimeoutError(scheduleToCloseTimeoutMs),
      });
    }
    return heartbeatTimeoutMs === undefined
      ? { fixed }
      : {
          fixed,
          heartbeat: {
            delayMs: heartbeatTimeoutMs,
            error: () => new StepHeartbeatTimeoutError(heartbeatTimeoutMs),
          },
        };
  }

  function heartbeatWriter(
    runId: string,
    stepId: string,
    attempt: number,
  ): { send(details: unknown): void; flush(): Promise<void>; close(): void } {
    let closed = false;
    let queued: { readonly details: unknown } | undefined;
    let inFlight: Promise<void> | undefined;
    const drain = async (): Promise<void> => {
      while (queued !== undefined) {
        const { details } = queued;
        queued = undefined;
        await heartbeats
          .record({ runId, stepId, attempt, details, recordedAt: clock.now() })
          .catch(() => undefined);
      }
      inFlight = undefined;
    };
    return {
      send(details: unknown): void {
        if (closed) {
          return;
        }
        queued = { details };
        inFlight ??= drain();
      },
      async flush(): Promise<void> {
        await inFlight;
      },
      close(): void {
        closed = true;
      },
    };
  }

  async function executeTraced(
    definition: StepDefinition | undefined,
    payload: { readonly stepType: string; readonly input: unknown },
    context: Omit<StepContext, "signal" | "heartbeat">,
    writer: { send(details: unknown): void },
    scheduleDeadline: Date | undefined,
    span: TraceSpan,
    leaseSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    const abortion = rejectOnAbort(leaseSignal);
    try {
      if (definition === undefined) {
        throw new NonRetryableError(`no step registered for type "${payload.stepType}"`);
      }
      const run = runWithDeadlines(
        (deadlineSignal, restartHeartbeat) =>
          definition.handler(payloadCodec.decode(payload.input), {
            ...context,
            signal:
              leaseSignal === undefined
                ? deadlineSignal
                : AbortSignal.any([deadlineSignal, leaseSignal]),
            heartbeat: (details?: unknown): void => {
              if (deadlineSignal.aborted || isAborted(leaseSignal)) {
                return;
              }
              restartHeartbeat();
              writer.send(payloadCodec.encode(details));
            },
          }),
        attemptDeadlines(definition, scheduleDeadline),
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

  function scheduleDeadlineOf(
    definition: StepDefinition | undefined,
    scheduledAt: string | undefined,
  ): Date | undefined {
    const timeoutMs = definition?.scheduleToCloseTimeoutMs;
    if (timeoutMs === undefined || scheduledAt === undefined) {
      return undefined;
    }
    return new Date(new Date(scheduledAt).getTime() + timeoutMs);
  }

  async function settleStep(
    task: LeasedTask,
    result: Omit<RecordStepResultInput, "runId"> | undefined,
  ): Promise<{ readonly recorded: boolean; readonly acked: boolean }> {
    const followUp = options.followUp;
    if (followUp !== undefined) {
      return options.recorder.completeStepTask(task, {
        ...(result === undefined ? {} : { result }),
        followUpQueue: followUp.queueName,
        followUpPayload: { reason: "step_completed" },
        ...(followUp.clock === undefined ? {} : { now: followUp.clock.now() }),
      });
    }
    const recorded =
      result === undefined
        ? { recorded: false }
        : await options.recorder.recordStepResult({ ...result, runId: task.runId });
    await options.beforeSettle?.(task);
    const acked = await options.queue.ack(task.id, task.leaseToken);
    return { recorded: recorded.recorded, acked };
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
        await settleStep(task, undefined);
        return { status: "already_recorded" };
      }

      const attempt = await options.attempts.nextAttempt(runId, stepId);
      const definition = options.lookup(payload.stepType);
      const policy: RetryPolicy = definition?.retry ?? DEFAULT_RETRY_POLICY;
      const scheduleDeadline = scheduleDeadlineOf(definition, payload.scheduledAt);
      const scheduleTimeoutMs = definition?.scheduleToCloseTimeoutMs;

      const failStep = async (error: SerializedError): Promise<StepTaskOutcome> => {
        await options.attempts.recordFailure({ runId, stepId, attempt, error, retryAt: null });
        const recorded = await settleStep(task, {
          stepId,
          attemptKey: `attempt-${String(attempt)}`,
          outcome: { status: "failed", error },
        });
        return recorded.recorded ? { status: "failed", attempt } : { status: "already_recorded" };
      };

      if (
        scheduleDeadline !== undefined &&
        scheduleTimeoutMs !== undefined &&
        clock.now().getTime() >= scheduleDeadline.getTime()
      ) {
        return failStep(serializeError(new StepScheduleToCloseTimeoutError(scheduleTimeoutMs)));
      }

      const previous = await heartbeats.read(runId, stepId);
      const writer = heartbeatWriter(runId, stepId, attempt);
      const span = tracing.startSpan(`step ${payload.stepType}`, {
        parent: await readTraceparent(runId),
        attributes: {
          "dee.run.id": runId,
          "dee.step.id": stepId,
          "dee.step.type": payload.stepType,
          "dee.step.attempt": attempt,
        },
      });

      let result: unknown;
      try {
        result = await executeTraced(
          definition,
          payload,
          { attempt, heartbeatDetails: payloadCodec.decode(previous?.details ?? undefined) },
          writer,
          scheduleDeadline,
          span,
          context.signal,
        );
      } catch (thrown) {
        writer.close();
        await writer.flush();
        if (isAborted(context.signal)) {
          return { status: "lease_lost" };
        }
        const error = serializeError(thrown);
        if (thrown instanceof StepScheduleToCloseTimeoutError) {
          return failStep(error);
        }
        const decision = decideRetry(policy, attempt - payload.attemptOffset, error, random);

        if (decision.retry) {
          const retryAt = new Date(clock.now().getTime() + decision.delayMs);
          if (
            scheduleDeadline !== undefined &&
            scheduleTimeoutMs !== undefined &&
            retryAt.getTime() >= scheduleDeadline.getTime()
          ) {
            return failStep(
              serializeError(
                new StepScheduleToCloseTimeoutError(scheduleTimeoutMs, { cause: thrown }),
              ),
            );
          }
          await options.attempts.recordFailure({ runId, stepId, attempt, error, retryAt });
          const nacked = await options.queue.nack(task.id, task.leaseToken, decision.delayMs);
          return nacked
            ? { status: "retry_scheduled", attempt, delayMs: decision.delayMs, retryAt }
            : { status: "lease_lost" };
        }

        if (decision.reason === "NON_RETRYABLE") {
          return failStep(error);
        }
        await options.attempts.recordFailure({ runId, stepId, attempt, error, retryAt: null });
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
      writer.close();
      await writer.flush();
      const recorded = await settleStep(task, {
        stepId,
        attemptKey: `attempt-${String(attempt)}`,
        outcome: { status: "completed", result: payloadCodec.encode(result) },
      });
      if (!recorded.acked) {
        return { status: "lease_lost" };
      }
      return recorded.recorded ? { status: "completed", attempt } : { status: "already_recorded" };
    },
  };
}
