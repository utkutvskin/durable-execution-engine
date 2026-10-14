import {
  createQuotaStore,
  createRateLimiter,
  type Pool,
  type QuotaStore,
  type RateLimiter,
} from "@dee/core";

/**
 * What a request will do, as far as limits are concerned. Reads only spend
 * rate limit tokens. Writes enqueue a task, so they are also checked against
 * the pending task quota and the queue depth. A start also creates a run.
 */
export type RequestKind = "read" | "write" | "start";

/**
 * Why a request was turned away. `retryAfterSeconds` goes into the
 * `Retry-After` header.
 */
export interface Rejection {
  readonly status: 429 | 503;
  readonly code: "rate_limited" | "run_quota_exceeded" | "task_quota_exceeded" | "overloaded";
  readonly message: string;
  readonly retryAfterSeconds: number;
}

/**
 * Decides whether a namespace may make a request right now.
 */
export interface QuotaGuard {
  /** Resolves `undefined` when the request may proceed. */
  check(namespaceId: string, kind: RequestKind): Promise<Rejection | undefined>;
}

/**
 * Options for `createQuotaGuard`. `queueName` and `maxQueueDepth` enable
 * backpressure: while the queue holds `maxQueueDepth` or more pending tasks,
 * writes of every namespace are answered 503. `quotaRetryAfterSeconds` is
 * the wait advertised for quota overruns, which clear only when runs or
 * tasks finish.
 */
export interface QuotaGuardOptions {
  readonly quotas?: QuotaStore;
  readonly limiter?: RateLimiter;
  readonly queueName?: string;
  readonly maxQueueDepth?: number;
  readonly quotaRetryAfterSeconds?: number;
}

const DEFAULT_QUOTA_RETRY_AFTER_SECONDS = 5;

/**
 * Creates a `QuotaGuard` over `pool`. The rate limit is checked first and
 * spends a token even when the request is refused later; the checks of
 * usage are read-then-write, so concurrent writes may overshoot a quota by
 * the number of requests in flight.
 */
export function createQuotaGuard(pool: Pool, options: QuotaGuardOptions = {}): QuotaGuard {
  const quotas = options.quotas ?? createQuotaStore(pool);
  const limiter = options.limiter ?? createRateLimiter();
  const quotaRetryAfter = options.quotaRetryAfterSeconds ?? DEFAULT_QUOTA_RETRY_AFTER_SECONDS;

  return {
    async check(namespaceId: string, kind: RequestKind): Promise<Rejection | undefined> {
      const quota = await quotas.get(namespaceId);

      if (quota.ratePerSecond !== null) {
        const decision = limiter.take(namespaceId, {
          ratePerSecond: quota.ratePerSecond,
          burst: quota.burst ?? Math.max(1, Math.ceil(quota.ratePerSecond)),
        });
        if (!decision.allowed) {
          return {
            status: 429,
            code: "rate_limited",
            message: "the namespace exceeded its request rate limit",
            retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
          };
        }
      }

      if (kind === "read") {
        return undefined;
      }

      if (options.queueName !== undefined && options.maxQueueDepth !== undefined) {
        const depth = await quotas.queueDepth(options.queueName);
        if (depth >= options.maxQueueDepth) {
          return {
            status: 503,
            code: "overloaded",
            message: "the task queue is full, try again later",
            retryAfterSeconds: quotaRetryAfter,
          };
        }
      }

      if (quota.maxPendingTasks === null && quota.maxConcurrentRuns === null) {
        return undefined;
      }
      const usage = await quotas.usage(namespaceId);
      if (quota.maxPendingTasks !== null && usage.pendingTasks >= quota.maxPendingTasks) {
        return {
          status: 429,
          code: "task_quota_exceeded",
          message: `the namespace has ${String(usage.pendingTasks)} pending tasks, the limit is ${String(quota.maxPendingTasks)}`,
          retryAfterSeconds: quotaRetryAfter,
        };
      }
      if (
        kind === "start" &&
        quota.maxConcurrentRuns !== null &&
        usage.openRuns >= quota.maxConcurrentRuns
      ) {
        return {
          status: 429,
          code: "run_quota_exceeded",
          message: `the namespace has ${String(usage.openRuns)} open runs, the limit is ${String(quota.maxConcurrentRuns)}`,
          retryAfterSeconds: quotaRetryAfter,
        };
      }
      return undefined;
    },
  };
}
