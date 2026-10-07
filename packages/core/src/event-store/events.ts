import { z } from "zod";

/**
 * A workflow run started with the given input. Always the first event in a
 * run's history.
 */
export const runStartedEventSchema = z.object({
  type: z.literal("run_started"),
  workflowType: z.string().min(1),
  input: z.unknown(),
});

/**
 * The run reached its `COMPLETED` state with the given result.
 */
export const runCompletedEventSchema = z.object({
  type: z.literal("run_completed"),
  result: z.unknown(),
});

/**
 * The run reached its `FAILED` state with the given error.
 */
export const runFailedEventSchema = z.object({
  type: z.literal("run_failed"),
  error: z.object({
    name: z.string(),
    message: z.string(),
  }),
});

/**
 * The run reached its `TIMED_OUT` state because it exceeded its allowed
 * duration.
 */
export const runTimedOutEventSchema = z.object({
  type: z.literal("run_timed_out"),
});

/**
 * The run reached its `CANCELLED` state after a cooperative cancellation
 * request.
 */
export const runCancelledEventSchema = z.object({
  type: z.literal("run_cancelled"),
  reason: z.string().optional(),
});

/**
 * The run reached its `TERMINATED` state after a forced termination that
 * did not wait for the workflow to react.
 */
export const runTerminatedEventSchema = z.object({
  type: z.literal("run_terminated"),
  reason: z.string().optional(),
});

/**
 * A step was scheduled for execution with the given input.
 */
export const stepScheduledEventSchema = z.object({
  type: z.literal("step_scheduled"),
  stepId: z.string().min(1),
  stepType: z.string().min(1),
  input: z.unknown(),
});

/**
 * A previously scheduled step finished successfully with the given result.
 */
export const stepCompletedEventSchema = z.object({
  type: z.literal("step_completed"),
  stepId: z.string().min(1),
  result: z.unknown(),
});

/**
 * A previously scheduled step finished with the given error.
 */
export const stepFailedEventSchema = z.object({
  type: z.literal("step_failed"),
  stepId: z.string().min(1),
  error: z.object({
    name: z.string(),
    message: z.string(),
  }),
});

/**
 * One attempt of a step failed. `attempt` counts from 1 across the step's
 * whole life. `retryAt` (an ISO-8601 string) is when the next attempt is due,
 * or `null` when the failure ended the retrying.
 */
export const stepAttemptFailedEventSchema = z.object({
  type: z.literal("step_attempt_failed"),
  stepId: z.string().min(1),
  attempt: z.number().int().positive(),
  error: z.object({
    name: z.string(),
    message: z.string(),
  }),
  retryAt: z.string().min(1).nullable(),
});

/**
 * A durable timer was started, due to fire at `fireAt` (an ISO-8601 string).
 */
export const timerStartedEventSchema = z.object({
  type: z.literal("timer_started"),
  timerId: z.string().min(1),
  fireAt: z.string().min(1),
});

/**
 * A previously started timer fired.
 */
export const timerFiredEventSchema = z.object({
  type: z.literal("timer_fired"),
  timerId: z.string().min(1),
});

/**
 * An external signal named `signalName` was delivered to the run with the
 * given payload. It stays in the history until a `ctx.waitForSignal()` call
 * consumes it, so a signal that arrives before the wait is not lost.
 */
export const signalReceivedEventSchema = z.object({
  type: z.literal("signal_received"),
  signalName: z.string().min(1),
  payload: z.unknown(),
});

/**
 * Every event kind that can be appended to a run's event log, discriminated
 * on `type`. This is the closed set `EventStore.append` validates against:
 * a payload that does not match one of these shapes is rejected before it
 * reaches postgres.
 */
export const workflowEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runTimedOutEventSchema,
  runCancelledEventSchema,
  runTerminatedEventSchema,
  stepScheduledEventSchema,
  stepCompletedEventSchema,
  stepFailedEventSchema,
  stepAttemptFailedEventSchema,
  timerStartedEventSchema,
  timerFiredEventSchema,
  signalReceivedEventSchema,
]);

/**
 * A single validated event, as accepted by `EventStore.append` and returned
 * (inside a `StoredEvent`) by `EventStore.read`.
 */
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
