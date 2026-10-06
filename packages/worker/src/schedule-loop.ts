import type { ScheduleManager, ScheduleTickReport } from "@dee/core";
import { systemTimers, type Timers } from "./timers.js";

/**
 * Configuration for `startScheduleLoop`. `onTick` receives each report and
 * `onError` the errors a tick survives.
 */
export interface ScheduleLoopOptions {
  readonly manager: ScheduleManager;
  readonly intervalMs: number;
  readonly timers?: Timers;
  readonly onTick?: (report: ScheduleTickReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running schedule loop.
 */
export interface ScheduleLoop {
  /** Cancels the next tick and waits for one in progress. */
  stop(): Promise<void>;
}

/**
 * Starts the runs of due cron schedules: once immediately, which is the
 * catch-up for every trigger that came due while the engine was down, and then every `intervalMs`,
 * one pass at a time. A failing pass is reported to `onError` and does not
 * end the loop.
 */
export function startScheduleLoop(options: ScheduleLoopOptions): ScheduleLoop {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError(
      `intervalMs must be a positive integer, got ${String(options.intervalMs)}`,
    );
  }
  const timers = options.timers ?? systemTimers;
  let handle: unknown;
  let stopped = false;

  async function runPass(): Promise<void> {
    handle = undefined;
    try {
      const report = await options.manager.catchUp();
      options.onTick?.(report);
    } catch (error) {
      options.onError?.(error);
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) {
      return;
    }
    handle = timers.setTimeout(() => {
      current = runPass();
    }, options.intervalMs);
  }

  let current: Promise<void> = runPass();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
      await current;
    },
  };
}
