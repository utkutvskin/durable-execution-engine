import type { Pool } from "pg";
import { systemClock, type ClockSource } from "../workflow/sources.ts";
import type { RateLimitDecision } from "./token-bucket.ts";

/**
 * A rate limit shared by every process on one database: at most
 * `limitPerPeriod` admissions in any window of `periodMs` milliseconds.
 * The window slides, so no instant lets more than `limitPerPeriod` through
 * within one period, not even across the edge of a fixed window.
 */
export interface RateLimitRule {
  readonly limitPerPeriod: number;
  readonly periodMs: number;
}

/**
 * A rate limit whose bucket is chosen per input, for example
 * `(request) => request.tenantId`. Without `key` every input shares one
 * bucket.
 */
export interface KeyedRateLimitRule<TInput = never> extends RateLimitRule {
  readonly key?: (input: TInput) => string;
}

/**
 * Thrown when a rate limit rule has a limit or a period that is not a
 * positive integer, or a key function that does not give a non-empty string.
 */
export class InvalidRateLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRateLimitError";
  }
}

/**
 * The longest bucket name, in characters, that a rate limit may use.
 */
export const MAX_RATE_LIMIT_BUCKET_LENGTH = 512;

/**
 * Checks `rule`, naming `owner` in the error message. Returns the rule.
 */
export function validateRateLimitRule<TRule extends RateLimitRule>(
  owner: string,
  rule: TRule,
): TRule {
  if (!Number.isInteger(rule.limitPerPeriod) || rule.limitPerPeriod <= 0) {
    throw new InvalidRateLimitError(
      `${owner} has a rate limit that is not a positive integer (${String(rule.limitPerPeriod)})`,
    );
  }
  if (!Number.isInteger(rule.periodMs) || rule.periodMs <= 0) {
    throw new InvalidRateLimitError(
      `${owner} has a rate limit period that is not a positive integer of milliseconds (${String(rule.periodMs)})`,
    );
  }
  const key: unknown = (rule as { readonly key?: unknown }).key;
  if (key !== undefined && typeof key !== "function") {
    throw new InvalidRateLimitError(`${owner} has a rate limit key that is not a function`);
  }
  return rule;
}

/**
 * Evaluates the bucket of a keyed rule for `input`: `prefix` alone without a
 * key function, `prefix:key` with one. Rejects with `InvalidRateLimitError`
 * when the key is not a non-empty string or the bucket gets longer than
 * `MAX_RATE_LIMIT_BUCKET_LENGTH`.
 */
export function resolveRateLimitBucket<TInput>(
  owner: string,
  prefix: string,
  rule: KeyedRateLimitRule<TInput>,
  input: TInput,
): string {
  if (rule.key === undefined) {
    return prefix;
  }
  const key: unknown = rule.key(input);
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidRateLimitError(
      `${owner} gave a rate limit key that is not a non-empty string`,
    );
  }
  const bucket = `${prefix}:${key}`;
  if (bucket.length > MAX_RATE_LIMIT_BUCKET_LENGTH) {
    throw new InvalidRateLimitError(
      `${owner} gave a rate limit key longer than ${String(MAX_RATE_LIMIT_BUCKET_LENGTH)} characters`,
    );
  }
  return bucket;
}

/**
 * Takes admissions from buckets kept in Postgres, so every process that
 * shares the database shares the limit.
 */
export interface SharedRateLimiter {
  /**
   * Admits one call to `bucket` when fewer than `rule.limitPerPeriod` were
   * admitted in the last `rule.periodMs`. A refused call records nothing;
   * `retryAfterMs` is the time until the oldest admission in the window
   * leaves it.
   */
  take(bucket: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

/**
 * Creates a `SharedRateLimiter` over `pool`. `clock` supplies "now", so a
 * test moves time without waiting; processes sharing a bucket are expected
 * to share a clock. Each call is one statement: the bucket is locked with a
 * transaction scoped advisory lock, admissions that left the window are
 * deleted, and the call is admitted or refused, so a bucket holds at most
 * `limitPerPeriod` rows.
 */
export function createSharedRateLimiter(
  pool: Pool,
  options: { readonly clock?: ClockSource } = {},
): SharedRateLimiter {
  const clock = options.clock ?? systemClock;
  return {
    async take(bucket: string, rule: RateLimitRule): Promise<RateLimitDecision> {
      validateRateLimitRule(`rate limit bucket "${bucket}"`, rule);
      const result = await pool.query<{
        allowed: boolean;
        retry_after_ms: string;
        remaining: number;
      }>(`select allowed, retry_after_ms, remaining from take_rate_limit($1, $2, $3, $4)`, [
        bucket,
        rule.limitPerPeriod,
        rule.periodMs,
        clock.now(),
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`take_rate_limit returned no row for bucket "${bucket}"`);
      }
      return {
        allowed: row.allowed,
        retryAfterMs: Number(row.retry_after_ms),
        remaining: row.remaining,
      };
    },
  };
}

/**
 * Turns a namespace quota's token bucket settings into a shared rate limit:
 * `burst` admissions (by default the rate rounded up, at least 1) per the
 * period in which `ratePerSecond` refills them, so the long-run rate stays
 * `ratePerSecond`.
 */
export function quotaRateLimitRule(ratePerSecond: number, burst: number | null): RateLimitRule {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new InvalidRateLimitError(`ratePerSecond must be positive, got ${String(ratePerSecond)}`);
  }
  const limitPerPeriod = burst ?? Math.max(1, Math.ceil(ratePerSecond));
  return {
    limitPerPeriod,
    periodMs: Math.max(1, Math.round((limitPerPeriod / ratePerSecond) * 1000)),
  };
}

/**
 * Hands a leased task back to the queue without running it, visible again
 * at `visibleAt`, for example when a rate limit refused it. Nothing ran
 * under the lease and no attempt is counted. Resolves `false`, writing
 * nothing, when the lease is no longer current.
 */
export async function deferLeasedTask(
  pool: Pool,
  task: { readonly taskId: string; readonly leaseToken: string },
  visibleAt: Date,
): Promise<boolean> {
  const released = await pool.query(
    `update tasks
     set state = 'PENDING', lease_token = null, leased_by = null, leased_by_version = null,
         visible_at = $3, updated_at = $3
     where id = $1 and lease_token = $2 and state = 'LEASED'`,
    [task.taskId, task.leaseToken, visibleAt],
  );
  return released.rowCount === 1;
}
