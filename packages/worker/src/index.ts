/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/worker";

export { LeaseLostError, ShutdownTimeoutError } from "./errors.js";
export { installShutdownHandlers } from "./shutdown.js";
export type { ProcessLike } from "./shutdown.js";
export { systemTimers } from "./timers.js";
export type { Timers } from "./timers.js";
export { createWorker } from "./worker.js";
export type { StopResult, TaskContext, TaskHandler, Worker, WorkerOptions } from "./worker.js";
export { createWorkerIdentity } from "./identity.js";
export type { WorkerIdentity, WorkerIdentityOptions } from "./identity.js";
export { startJanitorLoop } from "./janitor-loop.js";
export type { JanitorLoop, JanitorLoopOptions } from "./janitor-loop.js";
export { startTimerLoop } from "./timer-loop.js";
export type { TimerLoop, TimerLoopOptions } from "./timer-loop.js";
