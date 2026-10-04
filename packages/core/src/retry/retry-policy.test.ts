import { describe, expect, it } from "vitest";
import type { RandomSource } from "../workflow/sources.js";
import {
  DEFAULT_RETRY_POLICY,
  NonRetryableError,
  computeBackoffMs,
  decideRetry,
  isNonRetryable,
  resolveRetryPolicy,
} from "./retry-policy.js";

function fixedRandom(value: number): RandomSource {
  return { random: () => value, uuid: () => "00000000-0000-0000-0000-000000000000" };
}

const plain = resolveRetryPolicy({
  initialIntervalMs: 1000,
  backoffCoefficient: 2,
  maxIntervalMs: 10_000,
  maxAttempts: 6,
  jitter: 0,
});

describe("retry policy", () => {
  it("grows the wait by the backoff coefficient and stops at the maximum interval", () => {
    const waits = [1, 2, 3, 4, 5].map((attempt) =>
      computeBackoffMs(plain, attempt, fixedRandom(0)),
    );
    expect(waits).toEqual([1000, 2000, 4000, 8000, 10_000]);
  });

  it("supports a fractional coefficient", () => {
    const policy = resolveRetryPolicy({
      initialIntervalMs: 200,
      backoffCoefficient: 1.5,
      maxIntervalMs: 60_000,
      jitter: 0,
    });
    expect([1, 2, 3].map((attempt) => computeBackoffMs(policy, attempt, fixedRandom(0)))).toEqual([
      200, 300, 450,
    ]);
  });

  it("spreads the wait by the jitter fraction around the capped value", () => {
    const policy = resolveRetryPolicy({ ...plain, jitter: 0.5 });
    expect(computeBackoffMs(policy, 1, fixedRandom(0))).toBe(500);
    expect(computeBackoffMs(policy, 1, fixedRandom(0.5))).toBe(1000);
    expect(computeBackoffMs(policy, 1, fixedRandom(1))).toBe(1500);
  });

  it("never lets jitter push the wait above the maximum interval", () => {
    const policy = resolveRetryPolicy({ ...plain, jitter: 1 });
    expect(computeBackoffMs(policy, 5, fixedRandom(1))).toBe(10_000);
  });

  it("does not draw a random number when the policy has no jitter", () => {
    let draws = 0;
    const counting: RandomSource = {
      random: () => {
        draws += 1;
        return 0.5;
      },
      uuid: () => "id",
    };
    computeBackoffMs(plain, 3, counting);
    expect(draws).toBe(0);
  });

  it("retries until maxAttempts is used up, then gives up", () => {
    const policy = resolveRetryPolicy({ ...plain, maxAttempts: 3 });
    const error = { name: "Error", message: "boom" };
    expect(decideRetry(policy, 1, error, fixedRandom(0))).toEqual({ retry: true, delayMs: 1000 });
    expect(decideRetry(policy, 2, error, fixedRandom(0))).toEqual({ retry: true, delayMs: 2000 });
    expect(decideRetry(policy, 3, error, fixedRandom(0))).toEqual({
      retry: false,
      reason: "MAX_ATTEMPTS_EXHAUSTED",
    });
  });

  it("never retries a NonRetryableError, even on the first attempt", () => {
    const thrown = new NonRetryableError("card declined");
    const decision = decideRetry(
      plain,
      1,
      { name: thrown.name, message: thrown.message },
      fixedRandom(0),
    );
    expect(decision).toEqual({ retry: false, reason: "NON_RETRYABLE" });
  });

  it("treats an error named in nonRetryableErrorNames as non-retryable", () => {
    const policy = resolveRetryPolicy({ ...plain, nonRetryableErrorNames: ["ValidationError"] });
    expect(isNonRetryable({ name: "ValidationError", message: "bad" }, policy)).toBe(true);
    expect(isNonRetryable({ name: "TypeError", message: "bad" }, policy)).toBe(false);
  });

  it("fills a partial policy from the defaults", () => {
    expect(resolveRetryPolicy({ maxAttempts: 9 })).toEqual({
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 9,
    });
  });

  it.each([
    [{ initialIntervalMs: 0 }],
    [{ backoffCoefficient: 0.5 }],
    [{ initialIntervalMs: 5000, maxIntervalMs: 1000 }],
    [{ maxAttempts: 0 }],
    [{ maxAttempts: 2.5 }],
    [{ jitter: 1.5 }],
    [{ jitter: -0.1 }],
  ])("rejects the invalid policy %j", (partial) => {
    expect(() => resolveRetryPolicy(partial)).toThrow(RangeError);
  });

  it("names a NonRetryableError so the name survives serialization", () => {
    expect(new NonRetryableError("x").name).toBe("NonRetryableError");
    expect(new NonRetryableError("x")).toBeInstanceOf(Error);
  });
});
