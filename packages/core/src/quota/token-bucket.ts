import { systemClock, type ClockSource } from "../workflow/sources.js";

/**
 * The refill rate and capacity of one bucket. A bucket starts full, so a
 * burst of up to `burst` calls passes at once and the long-run rate is
 * `ratePerSecond`.
 */
export interface TokenBucketConfig {
  readonly ratePerSecond: number;
  readonly burst: number;
}

/**
 * The outcome of `RateLimiter.take`. When `allowed` is false,
 * `retryAfterMs` is the time until one token is available.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  readonly remaining: number;
}

/**
 * Keeps one token bucket per key, in process memory. Buckets of different
 * keys never share tokens.
 */
export interface RateLimiter {
  take(key: string, config: TokenBucketConfig): RateLimitDecision;
  reset(key: string): void;
}

interface BucketState {
  tokens: number;
  updatedAtMs: number;
}

function assertConfig(config: TokenBucketConfig): void {
  if (!Number.isFinite(config.ratePerSecond) || config.ratePerSecond <= 0) {
    throw new RangeError(`ratePerSecond must be positive, got ${String(config.ratePerSecond)}`);
  }
  if (!Number.isInteger(config.burst) || config.burst <= 0) {
    throw new RangeError(`burst must be a positive integer, got ${String(config.burst)}`);
  }
}

/**
 * Creates a `RateLimiter`. `clock` supplies "now", so tests move time
 * without waiting. A clock that steps backwards refills nothing.
 */
export function createRateLimiter(options: { readonly clock?: ClockSource } = {}): RateLimiter {
  const clock = options.clock ?? systemClock;
  const buckets = new Map<string, BucketState>();

  return {
    take(key: string, config: TokenBucketConfig): RateLimitDecision {
      assertConfig(config);
      const nowMs = clock.now().getTime();
      const bucket = buckets.get(key) ?? { tokens: config.burst, updatedAtMs: nowMs };
      const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
      bucket.tokens = Math.min(
        config.burst,
        bucket.tokens + (elapsedMs * config.ratePerSecond) / 1000,
      );
      bucket.updatedAtMs = Math.max(bucket.updatedAtMs, nowMs);
      buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
      }
      const missing = 1 - bucket.tokens;
      return {
        allowed: false,
        retryAfterMs: Math.ceil((missing / config.ratePerSecond) * 1000),
        remaining: 0,
      };
    },

    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
