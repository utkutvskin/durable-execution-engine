/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/worker";

export { LeaseLostError, ParkTaskError, ShutdownTimeoutError } from "./errors.ts";
export { installShutdownHandlers } from "./shutdown.ts";
export type { ProcessLike } from "./shutdown.ts";
export { systemTimers } from "./timers.ts";
export type { Timers } from "./timers.ts";
export { createWorker, nackDelayFor } from "./worker.ts";
export type {
  NackBackoff,
  SettledTask,
  StopResult,
  TaskContext,
  TaskHandler,
  Worker,
  WorkerOptions,
} from "./worker.ts";
export { createWorkerIdentity } from "./identity.ts";
export type { WorkerIdentity, WorkerIdentityOptions } from "./identity.ts";
export { startJanitorLoop } from "./janitor-loop.ts";
export type { JanitorLoop, JanitorLoopOptions } from "./janitor-loop.ts";
export { startTimerLoop } from "./timer-loop.ts";
export type { TimerLoop, TimerLoopOptions } from "./timer-loop.ts";
export { startScheduleLoop } from "./schedule-loop.ts";
export type { ScheduleLoop, ScheduleLoopOptions } from "./schedule-loop.ts";
export { createDepthBackpressure, pollBudgetForDepth } from "./backpressure.ts";
export type { DepthBackpressureOptions } from "./backpressure.ts";
export { UnknownWorkflowError, createEngineTaskHandler } from "./engine/task-handler.ts";
export type {
  AnyStepDefinition,
  AnyWorkflowDefinition,
  DecisionReport,
  EngineTaskHandlerOptions,
} from "./engine/task-handler.ts";
export { DEFAULT_QUEUE_NAME, startEngine } from "./engine/runtime.ts";
export type { CompactionOptions, DecisionTotals, Engine, EngineOptions } from "./engine/runtime.ts";
export { startCompactorLoop } from "./compactor-loop.ts";
export type { CompactorLoop, CompactorLoopOptions } from "./compactor-loop.ts";
export { startOpsServer } from "./ops-server.ts";
export type { OpsServer, OpsServerOptions } from "./ops-server.ts";
