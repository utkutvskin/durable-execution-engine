import { systemClock, type ClockSource } from "../workflow/sources.js";

/**
 * Limits of a `RunCache`. `maxRuns` bounds how many runs stay cached; the
 * least recently used one is evicted first. `stickyTimeoutMs` is how long an
 * entry may sit unused before it counts as gone.
 */
export interface RunCacheOptions {
  readonly maxRuns: number;
  readonly stickyTimeoutMs: number;
  readonly clock?: ClockSource;
}

/**
 * Counters a `RunCache` keeps about itself.
 */
export interface RunCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
}

/**
 * A per-worker, least recently used cache of per-run state, keyed by run id.
 */
export interface RunCache<TValue> {
  readonly size: number;
  get(runId: string): TValue | undefined;
  set(runId: string, value: TValue): void;
  delete(runId: string): boolean;
  clear(): void;
  stats(): RunCacheStats;
}

/**
 * Creates a `RunCache`. A `get` refreshes both recency and the idle timer; an
 * entry idle for longer than `stickyTimeoutMs` is dropped on the next `get`
 * and counted as an expiration and a miss.
 */
export function createRunCache<TValue>(options: RunCacheOptions): RunCache<TValue> {
  if (!Number.isInteger(options.maxRuns) || options.maxRuns < 1) {
    throw new RangeError(`maxRuns must be a positive integer, got ${String(options.maxRuns)}`);
  }
  if (!Number.isInteger(options.stickyTimeoutMs) || options.stickyTimeoutMs < 1) {
    throw new RangeError(
      `stickyTimeoutMs must be a positive integer, got ${String(options.stickyTimeoutMs)}`,
    );
  }
  const clock = options.clock ?? systemClock;
  const entries = new Map<string, { value: TValue; lastUsedAt: number }>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let expirations = 0;

  return {
    get size(): number {
      return entries.size;
    },

    get(runId: string): TValue | undefined {
      const entry = entries.get(runId);
      const now = clock.now().getTime();
      if (entry === undefined) {
        misses += 1;
        return undefined;
      }
      entries.delete(runId);
      if (now - entry.lastUsedAt > options.stickyTimeoutMs) {
        expirations += 1;
        misses += 1;
        return undefined;
      }
      entry.lastUsedAt = now;
      entries.set(runId, entry);
      hits += 1;
      return entry.value;
    },

    set(runId: string, value: TValue): void {
      entries.delete(runId);
      entries.set(runId, { value, lastUsedAt: clock.now().getTime() });
      while (entries.size > options.maxRuns) {
        const oldest = entries.keys().next();
        if (oldest.done === true) {
          break;
        }
        entries.delete(oldest.value);
        evictions += 1;
      }
    },

    delete(runId: string): boolean {
      return entries.delete(runId);
    },

    clear(): void {
      entries.clear();
    },

    stats(): RunCacheStats {
      return { hits, misses, evictions, expirations };
    },
  };
}
