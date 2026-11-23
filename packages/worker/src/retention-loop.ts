import type { RetentionReport, RetentionSweeper } from "@dee/core";
import { systemTimers, type Timers } from "./timers.ts";

/**
 * Configuration for `startRetentionLoop`. `onSweep` receives each report and
 * `onError` the errors a sweep survives.
 */
export interface RetentionLoopOptions {
  readonly sweeper: RetentionSweeper;
  readonly intervalMs: number;
  readonly timers?: Timers;
  readonly onSweep?: (report: RetentionReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running retention schedule.
 */
export interface RetentionLoop {
  /** Cancels the next sweep and waits for one in progress. */
  stop(): Promise<void>;
}

/**
 * Runs `sweeper.sweep` every `intervalMs`, one sweep at a time: finished
 * tasks move to `task_history` and closed runs past their namespace's
 * retention are purged. A failing sweep is reported to `onError` and does
 * not end the loop.
 */
export function startRetentionLoop(options: RetentionLoopOptions): RetentionLoop {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError(
      `intervalMs must be a positive integer, got ${String(options.intervalMs)}`,
    );
  }
  const timers = options.timers ?? systemTimers;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();
  let stopped = false;

  async function runSweep(): Promise<void> {
    handle = undefined;
    try {
      const report = await options.sweeper.sweep();
      options.onSweep?.(report);
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
      current = runSweep();
    }, options.intervalMs);
  }

  schedule();

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
