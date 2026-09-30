/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/core";

export type { Codec } from "./event-store/codec.js";
export {
  createGzipCodec,
  createSizeLimitedCodec,
  DEFAULT_MAX_PAYLOAD_BYTES,
  jsonCodec,
  maskSensitiveFields,
} from "./event-store/codec.js";
export { createPostgresEventStore } from "./event-store/event-store.js";
export type { EventStore, StoredEvent } from "./event-store/event-store.js";
export { ConcurrencyError, PayloadTooLargeError } from "./event-store/errors.js";
export {
  runCompletedEventSchema,
  runCancelledEventSchema,
  runFailedEventSchema,
  runStartedEventSchema,
  runTerminatedEventSchema,
  runTimedOutEventSchema,
  stepCompletedEventSchema,
  stepFailedEventSchema,
  stepScheduledEventSchema,
  timerFiredEventSchema,
  timerStartedEventSchema,
  workflowEventSchema,
} from "./event-store/events.js";
export type { WorkflowEvent } from "./event-store/events.js";

export type {
  CompleteRunCommand,
  FailRunCommand,
  ScheduleStepCommand,
  StartTimerCommand,
  WorkflowCommand,
} from "./workflow/commands.js";
export type { WorkflowContext, WorkflowHandler } from "./workflow/context.js";
export { runDecisionLoop } from "./workflow/decision-loop.js";
export type { DecisionLoopOptions, DecisionResult } from "./workflow/decision-loop.js";
export { InvalidTransitionError } from "./run/errors.js";
export {
  assertRunAcceptsCommand,
  assertTransition,
  isTerminalState,
  RUN_STATES,
  RUN_STATE_TRANSITIONS,
} from "./run/state-machine.js";
export type { RunState } from "./run/state-machine.js";
export {
  applyEventToProjection,
  createInitialProjection,
  foldRunEvents,
} from "./run/projection.js";
export type { RunProjection } from "./run/projection.js";
export { rebuildProjection, refreshProjection } from "./run/projection-store.js";
export { defineStep } from "./workflow/define-step.js";
export type { DefineStepOptions, StepDefinition } from "./workflow/define-step.js";
export { defineWorkflow } from "./workflow/define-workflow.js";
export { deserializeError, serializeError } from "./workflow/error-serialization.js";
export type { SerializedError } from "./workflow/error-serialization.js";
export { NonDeterminismError } from "./workflow/errors.js";
export { ForbiddenApiError } from "./workflow/sandbox.js";
export { runRegisteredWorkflowInMemory, runWorkflowInMemory } from "./workflow/run-workflow.js";
export type { RunWorkflowOptions, RunWorkflowResult } from "./workflow/run-workflow.js";
export { systemClock, systemRandomSource } from "./workflow/sources.js";
export type { ClockSource, RandomSource } from "./workflow/sources.js";
export { createStepRegistry } from "./workflow/step-registry.js";
export type { StepHandler, StepRegistry } from "./workflow/step-registry.js";
export { createWorkflowRegistry } from "./workflow/workflow-registry.js";
export type { WorkflowDefinition, WorkflowRegistry } from "./workflow/workflow-registry.js";
export { TASK_TYPES, createTaskQueue, taskQueueName } from "./queue/task-queue.js";
export type {
  DequeueOptions,
  EnqueueInput,
  LeasedTask,
  TaskQueue,
  TaskType,
} from "./queue/task-queue.js";
