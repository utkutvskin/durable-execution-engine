import type { Janitor, RecoverStalledRunsOptions, SweepReport } from "@dee/core";
import { systemTimers, type Timers } from "./timers.js";

/**
 * Configuration for `startJanitorLoop`. `stalledRuns`, when given, makes
 * every sweep also recover stalled runs. `onSweep` receives each report and
 * `onError` the errors a sweep survives.
 */
export interface JanitorLoopOptions {
  readonly janitor: Janitor;
  readonly intervalMs: number;
  readonly stalledRuns?: RecoverStalledRunsOptions;
  readonly timers?: Timers;
  readonly onSweep?: (report: SweepReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running janitor schedule.
 */
export interface JanitorLoop {
  /** Cancels the next sweep and waits for one in progress. */
  stop(): Promise<void>;
}

/**
 * Runs `janitor.sweep` every `intervalMs`, one sweep at a time: the next one
 * is scheduled only after the previous one finished. A failing sweep is
 * reported to `onError` and does not end the loop.
 */
export function startJanitorLoop(options: JanitorLoopOptions): JanitorLoop {
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
      const report = await options.janitor.sweep(options.stalledRuns);
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
