/**
 * Latency figures of one measured population, in milliseconds.
 */
export interface LatencySummary {
  readonly count: number;
  readonly minMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/**
 * Nearest-rank percentile of an ascending `sorted` sample. `fraction` is in
 * the range 0 to 1. An empty sample has no percentile and raises a
 * `RangeError`.
 */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    throw new RangeError("percentile of an empty sample is undefined");
  }
  if (fraction < 0 || fraction > 1) {
    throw new RangeError(`fraction must be between 0 and 1, got ${String(fraction)}`);
  }
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
}

/**
 * Summarizes `samplesMs` into count, mean, extremes and the p50, p95 and p99
 * percentiles. The input is not modified.
 */
export function summarizeLatencies(samplesMs: readonly number[]): LatencySummary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: percentile(sorted, 0),
    meanMs: total / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: percentile(sorted, 1),
  };
}

/**
 * Operations per second for `count` operations that took `elapsedMs`.
 */
export function perSecond(count: number, elapsedMs: number): number {
  if (elapsedMs <= 0) {
    throw new RangeError(`elapsedMs must be positive, got ${String(elapsedMs)}`);
  }
  return (count * 1000) / elapsedMs;
}
