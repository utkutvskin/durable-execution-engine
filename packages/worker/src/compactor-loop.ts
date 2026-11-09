import type { CompactionReport, HistoryCompactor } from "@dee/core";
import { systemTimers, type Timers } from "./timers.ts";

/**
 * Configuration for `startCompactorLoop`. `batchSize` bounds the runs one
 * sweep compacts. `onSweep` receives each report and `onError` the errors a
 * sweep survives.
 */
export interface CompactorLoopOptions {
  readonly compactor: HistoryCompactor;
  readonly intervalMs: number;
  readonly batchSize?: number;
  readonly timers?: Timers;
  readonly onSweep?: (report: CompactionReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running compactor schedule.
 */
export interface CompactorLoop {
  /** Cancels the next sweep and waits for one in progress. */
  stop(): Promise<void>;
}

/**
 * Runs `compactor.sweep` every `intervalMs`, one sweep at a time. A failing
 * sweep is reported to `onError` and does not end the loop.
 */
export function startCompactorLoop(options: CompactorLoopOptions): CompactorLoop {
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
      const report = await options.compactor.sweep(options.batchSize);
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
