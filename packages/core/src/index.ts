/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/core";

export type { Codec } from "./event-store/codec.js";
export { jsonCodec } from "./event-store/codec.js";
export { createPostgresEventStore } from "./event-store/event-store.js";
export type { EventStore, StoredEvent } from "./event-store/event-store.js";
export { ConcurrencyError } from "./event-store/errors.js";
export {
  runCompletedEventSchema,
  runFailedEventSchema,
  runStartedEventSchema,
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
export { defineWorkflow } from "./workflow/define-workflow.js";
export {
  runRegisteredWorkflowInMemory,
  runWorkflowInMemory,
} from "./workflow/run-workflow.js";
export type { RunWorkflowOptions, RunWorkflowResult } from "./workflow/run-workflow.js";
export { systemClock, systemRandomSource } from "./workflow/sources.js";
export type { ClockSource, RandomSource } from "./workflow/sources.js";
export { createStepRegistry } from "./workflow/step-registry.js";
export type { StepHandler, StepRegistry } from "./workflow/step-registry.js";
export { createWorkflowRegistry } from "./workflow/workflow-registry.js";
export type { WorkflowDefinition, WorkflowRegistry } from "./workflow/workflow-registry.js";
