/**
 * Options for `createDepthBackpressure`. `readDepth` reports how many tasks
 * wait in the queue. At or below `lowWatermark` the worker takes at most
 * `minBatch` tasks per poll; at or above `highWatermark` it takes every free
 * slot; in between the allowance grows linearly.
 */
export interface DepthBackpressureOptions {
  readonly readDepth: () => Promise<number>;
  readonly lowWatermark: number;
  readonly highWatermark: number;
  readonly minBatch?: number;
}

/**
 * Computes how many tasks to take for a queue of `depth` tasks and `free`
 * worker slots. A shallow queue is polled in small batches, so a burst of
 * work spreads over all workers instead of landing on whichever polled
 * first; a deep queue is drained with every slot.
 */
export function pollBudgetForDepth(
  depth: number,
  free: number,
  options: Pick<DepthBackpressureOptions, "lowWatermark" | "highWatermark" | "minBatch">,
): number {
  const minBatch = options.minBatch ?? 1;
  if (depth <= 0) {
    return 0;
  }
  if (depth >= options.highWatermark) {
    return free;
  }
  if (depth <= options.lowWatermark) {
    return Math.min(free, minBatch, depth);
  }
  const span = options.highWatermark - options.lowWatermark;
  const share = (depth - options.lowWatermark) / span;
  const scaled = Math.ceil(minBatch + share * (free - minBatch));
  return Math.min(free, Math.max(minBatch, scaled), depth);
}

/**
 * Builds a `WorkerOptions.pollBudget` that reads the queue depth before every
 * poll. An empty queue costs no dequeue query.
 */
export function createDepthBackpressure(
  options: DepthBackpressureOptions,
): (free: number) => Promise<number> {
  if (options.lowWatermark < 0 || options.highWatermark <= options.lowWatermark) {
    throw new RangeError("highWatermark must be greater than lowWatermark, which is not negative");
  }
  return async (free: number): Promise<number> => {
    const depth = await options.readDepth();
    return pollBudgetForDepth(depth, free, options);
  };
}
