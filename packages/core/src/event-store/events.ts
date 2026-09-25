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
 * Every event kind that can be appended to a run's event log, discriminated
 * on `type`. This is the closed set `EventStore.append` validates against:
 * a payload that does not match one of these shapes is rejected before it
 * reaches postgres.
 */
export const workflowEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  stepScheduledEventSchema,
  stepCompletedEventSchema,
  stepFailedEventSchema,
  timerStartedEventSchema,
  timerFiredEventSchema,
]);

/**
 * A single validated event, as accepted by `EventStore.append` and returned
 * (inside a `StoredEvent`) by `EventStore.read`.
 */
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
