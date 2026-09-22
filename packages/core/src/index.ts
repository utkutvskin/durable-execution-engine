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
