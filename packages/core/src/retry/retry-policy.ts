import type { SerializedError } from "../workflow/error-serialization.js";
import type { RandomSource } from "../workflow/sources.js";

/**
 * How a failing step is retried. `maxAttempts` counts every attempt including
 * the first. The wait before attempt `n + 1` is
 * `initialIntervalMs * backoffCoefficient ** (n - 1)`, capped at
 * `maxIntervalMs`, then spread by `jitter`: a fraction from 0 (none) to 1
 * (anywhere from no wait to double) of the capped wait, taken from a
 * `RandomSource` and never above `maxIntervalMs`.
 */
export interface RetryPolicy {
  readonly initialIntervalMs: number;
  readonly backoffCoefficient: number;
  readonly maxIntervalMs: number;
  readonly maxAttempts: number;
  readonly jitter: number;
  readonly nonRetryableErrorNames: readonly string[];
}

/**
 * The policy a step gets when it declares none: three attempts, one second
 * doubling up to one minute, a tenth of jitter.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  initialIntervalMs: 1000,
  backoffCoefficient: 2,
  maxIntervalMs: 60_000,
  maxAttempts: 3,
  jitter: 0.1,
  nonRetryableErrorNames: [],
};

/**
 * Thrown by a step to say that retrying cannot help. A step that throws it
 * (or any error named `NonRetryableError`, which survives serialization) is
 * never retried, whatever its policy says.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/**
 * Why a failed attempt will not be retried: the error said so, or the policy
 * has no attempts left.
 */
export type GiveUpReason = "NON_RETRYABLE" | "MAX_ATTEMPTS_EXHAUSTED";

/**
 * What to do after a failed attempt: retry after `delayMs`, or give up.
 */
export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false; readonly reason: GiveUpReason };

/**
 * Fills the gaps in a partial policy from `DEFAULT_RETRY_POLICY` and rejects
 * values that cannot work: a non-positive interval, a coefficient below 1, a
 * maximum interval below the initial one, a non-integer or non-positive
 * attempt count, or a jitter outside 0 to 1.
 */
export function resolveRetryPolicy(partial: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...partial };
  if (!(policy.initialIntervalMs > 0)) {
    throw new RangeError(
      `initialIntervalMs must be positive, got ${String(policy.initialIntervalMs)}`,
    );
  }
  if (!(policy.backoffCoefficient >= 1)) {
    throw new RangeError(
      `backoffCoefficient must be at least 1, got ${String(policy.backoffCoefficient)}`,
    );
  }
  if (!(policy.maxIntervalMs >= policy.initialIntervalMs)) {
    throw new RangeError(
      `maxIntervalMs (${String(policy.maxIntervalMs)}) must not be below initialIntervalMs (${String(policy.initialIntervalMs)})`,
    );
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts <= 0) {
    throw new RangeError(
      `maxAttempts must be a positive integer, got ${String(policy.maxAttempts)}`,
    );
  }
  if (!(policy.jitter >= 0 && policy.jitter <= 1)) {
    throw new RangeError(`jitter must be between 0 and 1, got ${String(policy.jitter)}`);
  }
  return policy;
}

/**
 * The wait in milliseconds after the `failedAttempt`-th attempt (1-based)
 * failed, before the next one starts. Draws one number from `random` only
 * when the policy has jitter.
 */
export function computeBackoffMs(
  policy: RetryPolicy,
  failedAttempt: number,
  random: RandomSource,
): number {
  const exponential = policy.initialIntervalMs * policy.backoffCoefficient ** (failedAttempt - 1);
  const capped = Math.min(exponential, policy.maxIntervalMs);
  if (policy.jitter === 0) {
    return Math.round(capped);
  }
  const spread = 1 + policy.jitter * (2 * random.random() - 1);
  return Math.round(Math.min(capped * spread, policy.maxIntervalMs));
}

/**
 * Whether `error` may never be retried: it is a `NonRetryableError`, or its
 * name is `NonRetryableError` or listed in the policy's
 * `nonRetryableErrorNames`.
 */
export function isNonRetryable(error: SerializedError, policy: RetryPolicy): boolean {
  return error.name === "NonRetryableError" || policy.nonRetryableErrorNames.includes(error.name);
}

/**
 * Decides what follows the `failedAttempt`-th attempt (1-based, counted from
 * the start of the current retry budget) failing with `error`.
 */
export function decideRetry(
  policy: RetryPolicy,
  failedAttempt: number,
  error: SerializedError,
  random: RandomSource,
): RetryDecision {
  if (isNonRetryable(error, policy)) {
    return { retry: false, reason: "NON_RETRYABLE" };
  }
  if (failedAttempt >= policy.maxAttempts) {
    return { retry: false, reason: "MAX_ATTEMPTS_EXHAUSTED" };
  }
  return { retry: true, delayMs: computeBackoffMs(policy, failedAttempt, random) };
}
