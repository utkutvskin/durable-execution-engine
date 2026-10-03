import type { LeasedTask, TaskQueue } from "@dee/core";
import type { WorkerIdentity } from "./identity.js";
import { LeaseLostError, ShutdownTimeoutError } from "./errors.js";
import { systemTimers, type Timers } from "./timers.js";

/**
 * What a task handler receives besides the task. `signal` aborts when the
 * task's lease is lost or a graceful shutdown drops the task; `signal.reason`
 * is then a `LeaseLostError` or a `ShutdownTimeoutError`.
 */
export interface TaskContext {
  readonly signal: AbortSignal;
}

/**
 * Runs one leased task. Resolving acks the task, throwing nacks it so it is
 * delivered again.
 */
export type TaskHandler = (task: LeasedTask, context: TaskContext) => Promise<void>;

/**
 * Configuration for `createWorker`.
 *
 * - `concurrency`: how many tasks run at once (default 1).
 * - `pollIntervalMs`: the wait after the first empty poll (default 1000);
 *   each further empty poll doubles it up to `maxPollIntervalMs` (default
 *   ten times `pollIntervalMs`), and a poll that finds work resets it.
 * - `visibilityTimeoutMs`: the lease length requested on dequeue and on
 *   every heartbeat (default 30000).
 * - `heartbeatIntervalMs`: how often a running task's lease is renewed
 *   (default a third of `visibilityTimeoutMs`); must be shorter than the
 *   visibility timeout.
 * - `shutdownTimeoutMs`: how long `stop` waits for running tasks before
 *   dropping them (default 30000).
 * - `nackDelayMs`: the redelivery delay of a task whose handler threw
 *   (default 0).
 * - `identity`: stamped on every leased task, so a reclaimed lease names
 *   the worker that lost it.
 * - `onError`: receives errors the worker survives, such as a failed poll.
 */
export interface WorkerOptions {
  readonly queue: TaskQueue;
  readonly queueName: string;
  readonly handler: TaskHandler;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly maxPollIntervalMs?: number;
  readonly visibilityTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly nackDelayMs?: number;
  readonly timers?: Timers;
  readonly identity?: WorkerIdentity;
  readonly onError?: (error: unknown) => void;
}

/**
 * What `Worker.stop` reports: `completed` tasks finished within the
 * shutdown timeout, `dropped` tasks were still running when it elapsed.
 */
export interface StopResult {
  readonly completed: number;
  readonly dropped: number;
}

/**
 * A polling task consumer.
 */
export interface Worker {
  /** Starts the poll loop. A worker can be started once. */
  start(): void;

  /**
   * Takes no new tasks, waits for the running ones up to `shutdownTimeoutMs`,
   * then aborts and nacks whatever is left. Calling it again returns the
   * same result.
   */
  stop(): Promise<StopResult>;

  /** The number of tasks currently running. */
  readonly activeCount: number;
}

interface RunningTask {
  readonly task: LeasedTask;
  readonly controller: AbortController;
  heartbeat: unknown;
  finished: boolean;
  dropped: boolean;
  done: Promise<void>;
}

interface ResolvedOptions {
  readonly queue: TaskQueue;
  readonly queueName: string;
  readonly handler: TaskHandler;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly maxPollIntervalMs: number;
  readonly visibilityTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly nackDelayMs: number;
  readonly timers: Timers;
  readonly identity: WorkerIdentity | undefined;
  readonly onError: (error: unknown) => void;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function requireNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

function resolveOptions(options: WorkerOptions): ResolvedOptions {
  const pollIntervalMs = requirePositiveInteger("pollIntervalMs", options.pollIntervalMs ?? 1000);
  const visibilityTimeoutMs = requirePositiveInteger(
    "visibilityTimeoutMs",
    options.visibilityTimeoutMs ?? 30_000,
  );
  const heartbeatIntervalMs = requirePositiveInteger(
    "heartbeatIntervalMs",
    options.heartbeatIntervalMs ?? Math.max(1, Math.floor(visibilityTimeoutMs / 3)),
  );
  if (heartbeatIntervalMs >= visibilityTimeoutMs) {
    throw new RangeError(
      `heartbeatIntervalMs (${String(heartbeatIntervalMs)}) must be shorter than visibilityTimeoutMs (${String(visibilityTimeoutMs)})`,
    );
  }
  const maxPollIntervalMs = requirePositiveInteger(
    "maxPollIntervalMs",
    options.maxPollIntervalMs ?? pollIntervalMs * 10,
  );
  if (maxPollIntervalMs < pollIntervalMs) {
    throw new RangeError("maxPollIntervalMs must not be shorter than pollIntervalMs");
  }
  return {
    queue: options.queue,
    queueName: options.queueName,
    handler: options.handler,
    concurrency: requirePositiveInteger("concurrency", options.concurrency ?? 1),
    pollIntervalMs,
    maxPollIntervalMs,
    visibilityTimeoutMs,
    heartbeatIntervalMs,
    shutdownTimeoutMs: requirePositiveInteger(
      "shutdownTimeoutMs",
      options.shutdownTimeoutMs ?? 30_000,
    ),
    nackDelayMs: requireNonNegativeInteger("nackDelayMs", options.nackDelayMs ?? 0),
    timers: options.timers ?? systemTimers,
    identity: options.identity,
    onError:
      options.onError ??
      ((): void => {
        return;
      }),
  };
}

/**
 * Creates a `Worker` that polls `options.queueName`, runs up to
 * `concurrency` tasks at once through `options.handler`, and renews each
 * running task's lease every `heartbeatIntervalMs` so a long task is not
 * handed to another consumer while it is still alive.
 *
 * When a heartbeat finds the lease gone, the task's signal is aborted and
 * the worker neither acks nor nacks it. An empty queue is polled with
 * exponential backoff.
 */
export function createWorker(options: WorkerOptions): Worker {
  const config = resolveOptions(options);
  const inFlight = new Map<string, RunningTask>();
  let state: "idle" | "running" | "stopping" | "stopped" = "idle";
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let stopping: Promise<StopResult> | undefined;

  function isRunning(): boolean {
    return state === "running";
  }

  function waitForWake(delayMs?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let handle: unknown;
      const done = (): void => {
        if (handle !== undefined) {
          config.timers.clearTimeout(handle);
        }
        wake = undefined;
        resolve();
      };
      wake = done;
      if (delayMs !== undefined) {
        handle = config.timers.setTimeout(done, delayMs);
      }
    });
  }

  function stopHeartbeat(running: RunningTask): void {
    running.finished = true;
    if (running.heartbeat !== undefined) {
      config.timers.clearTimeout(running.heartbeat);
      running.heartbeat = undefined;
    }
  }

  async function beat(running: RunningTask): Promise<void> {
    running.heartbeat = undefined;
    let leaseHeld = true;
    try {
      leaseHeld = await config.queue.extend(
        running.task.id,
        running.task.leaseToken,
        config.visibilityTimeoutMs,
      );
    } catch (error) {
      config.onError(error);
    }
    if (running.finished) {
      return;
    }
    if (!leaseHeld) {
      running.finished = true;
      running.controller.abort(new LeaseLostError(running.task.id));
      return;
    }
    scheduleHeartbeat(running);
  }

  function scheduleHeartbeat(running: RunningTask): void {
    running.heartbeat = config.timers.setTimeout(() => {
      void beat(running);
    }, config.heartbeatIntervalMs);
  }

  async function settle(running: RunningTask, failed: boolean): Promise<void> {
    const leaseLost = running.controller.signal.aborted;
    stopHeartbeat(running);
    if (running.dropped || leaseLost) {
      return;
    }
    try {
      if (failed) {
        await config.queue.nack(running.task.id, running.task.leaseToken, config.nackDelayMs);
      } else {
        await config.queue.ack(running.task.id, running.task.leaseToken);
      }
    } catch (error) {
      config.onError(error);
    }
  }

  async function execute(running: RunningTask): Promise<void> {
    let failed = false;
    try {
      await config.handler(running.task, { signal: running.controller.signal });
    } catch (error) {
      failed = true;
      config.onError(error);
    }
    await settle(running, failed);
    inFlight.delete(running.task.id);
    wake?.();
  }

  function launch(task: LeasedTask): void {
    const running: RunningTask = {
      task,
      controller: new AbortController(),
      heartbeat: undefined,
      finished: false,
      dropped: false,
      done: Promise.resolve(),
    };
    inFlight.set(task.id, running);
    scheduleHeartbeat(running);
    running.done = execute(running);
  }

  async function releaseUnstarted(tasks: readonly LeasedTask[]): Promise<void> {
    for (const task of tasks) {
      try {
        await config.queue.nack(task.id, task.leaseToken);
      } catch (error) {
        config.onError(error);
      }
    }
  }

  async function pollLoop(): Promise<void> {
    let delay = config.pollIntervalMs;
    while (isRunning()) {
      const free = config.concurrency - inFlight.size;
      if (free <= 0) {
        await waitForWake();
        continue;
      }
      let tasks: LeasedTask[] = [];
      try {
        tasks = await config.queue.dequeue({
          queueName: config.queueName,
          visibilityTimeoutMs: config.visibilityTimeoutMs,
          limit: free,
          ...(config.identity === undefined
            ? {}
            : { workerId: config.identity.id, workerVersion: config.identity.version }),
        });
      } catch (error) {
        config.onError(error);
      }
      if (!isRunning()) {
        await releaseUnstarted(tasks);
        return;
      }
      if (tasks.length > 0) {
        delay = config.pollIntervalMs;
        tasks.forEach(launch);
        continue;
      }
      await waitForWake(delay);
      delay = Math.min(delay * 2, config.maxPollIntervalMs);
    }
  }

  async function drop(running: RunningTask): Promise<void> {
    running.dropped = true;
    stopHeartbeat(running);
    running.controller.abort(new ShutdownTimeoutError(running.task.id));
    try {
      await config.queue.nack(running.task.id, running.task.leaseToken);
    } catch (error) {
      config.onError(error);
    }
    inFlight.delete(running.task.id);
  }

  async function shutDown(): Promise<StopResult> {
    state = "stopping";
    wake?.();
    await loop;
    const running = [...inFlight.values()];
    let deadline: unknown;
    const timeout = new Promise<"timeout">((resolve) => {
      deadline = config.timers.setTimeout(() => {
        resolve("timeout");
      }, config.shutdownTimeoutMs);
    });
    const finished = Promise.all(running.map((entry) => entry.done)).then(
      () => "finished" as const,
    );
    const outcome = await Promise.race([finished, timeout]);
    config.timers.clearTimeout(deadline);
    let dropped = 0;
    if (outcome === "timeout") {
      const stragglers = running.filter((entry) => inFlight.has(entry.task.id));
      dropped = stragglers.length;
      await Promise.all(stragglers.map(drop));
    }
    state = "stopped";
    return { completed: running.length - dropped, dropped };
  }

  return {
    start(): void {
      if (state !== "idle") {
        throw new Error("worker was already started");
      }
      state = "running";
      loop = pollLoop();
    },

    stop(): Promise<StopResult> {
      stopping ??= shutDown();
      return stopping;
    },

    get activeCount(): number {
      return inFlight.size;
    },
  };
}
