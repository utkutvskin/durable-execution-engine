import type { PartitionMaintainer, PartitionMaintenanceReport } from "@dee/core";
import { systemTimers, type Timers } from "./timers.ts";

/**
 * How often the elected engine maintains the `run_events` partitions when
 * `EngineOptions.partitions.intervalMs` is not given: once an hour.
 */
export const DEFAULT_PARTITION_INTERVAL_MS = 60 * 60_000;

/**
 * Configuration for `startPartitionLoop`. `onReport` receives each report
 * and `onError` the errors a run survives.
 */
export interface PartitionLoopOptions {
  readonly maintainer: PartitionMaintainer;
  readonly intervalMs: number;
  readonly timers?: Timers;
  readonly onReport?: (report: PartitionMaintenanceReport) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running partition maintenance schedule.
 */
export interface PartitionLoop {
  /** Cancels the next run and waits for one in progress. */
  stop(): Promise<void>;
}

/**
 * Runs `maintainer.runOnce` at once and then every `intervalMs`, one run at
 * a time, so a newly elected engine creates the partitions ahead before
 * anything else. A failing run is reported to `onError` and does not end
 * the loop.
 */
export function startPartitionLoop(options: PartitionLoopOptions): PartitionLoop {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError(
      `intervalMs must be a positive integer, got ${String(options.intervalMs)}`,
    );
  }
  const timers = options.timers ?? systemTimers;
  let handle: unknown;
  let stopped = false;

  async function runMaintenance(): Promise<void> {
    handle = undefined;
    try {
      const report = await options.maintainer.runOnce();
      options.onReport?.(report);
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) {
      handle = timers.setTimeout(() => {
        current = runMaintenance();
      }, options.intervalMs);
    }
  }

  let current: Promise<void> = runMaintenance();

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
