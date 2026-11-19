import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../db/env.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import {
  InvalidRateLimitError,
  createSharedRateLimiter,
  quotaRateLimitRule,
  resolveRateLimitBucket,
  validateRateLimitRule,
} from "./shared-rate-limiter.ts";

function movableClock(): { now(): Date; advance(ms: number): void } {
  let elapsed = 0;
  const start = new Date("2026-03-01T12:00:00.000Z").getTime();
  return {
    now: () => new Date(start + elapsed),
    advance(ms: number): void {
      elapsed += ms;
    },
  };
}

describe("shared rate limiter", () => {
  let database: IsolatedSchema;
  let extraPools: pg.Pool[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await Promise.all(extraPools.map((pool) => pool.end()));
    extraPools = [];
    await database.close();
  });

  it("admits the limit, refuses the rest and admits again once the oldest admission leaves the window", async () => {
    const clock = movableClock();
    const limiter = createSharedRateLimiter(database.pool, { clock });
    const rule = { limitPerPeriod: 3, periodMs: 1000 };
    const first = await limiter.take("window", rule);
    clock.advance(400);
    await limiter.take("window", rule);
    await limiter.take("window", rule);
    const refused = await limiter.take("window", rule);
    expect(first).toEqual({ allowed: true, retryAfterMs: 0, remaining: 2 });
    expect(refused).toEqual({ allowed: false, retryAfterMs: 600, remaining: 0 });
    clock.advance(599);
    expect((await limiter.take("window", rule)).allowed).toBe(false);
    clock.advance(1);
    expect((await limiter.take("window", rule)).allowed).toBe(true);
    expect((await limiter.take("window", rule)).allowed).toBe(false);
  });

  it("never admits more than the limit in any sliding window, even across a period edge", async () => {
    const clock = movableClock();
    const limiter = createSharedRateLimiter(database.pool, { clock });
    const rule = { limitPerPeriod: 5, periodMs: 1000 };
    const admittedAt: number[] = [];
    for (let step = 0; step < 60; step += 1) {
      if ((await limiter.take("sliding", rule)).allowed) {
        admittedAt.push(clock.now().getTime());
      }
      clock.advance(step % 7 === 0 ? 230 : 45);
    }
    for (const start of admittedAt) {
      const inWindow = admittedAt.filter((at) => at >= start && at < start + rule.periodMs);
      expect(inWindow.length).toBeLessThanOrEqual(rule.limitPerPeriod);
    }
    expect(admittedAt.length).toBeGreaterThan(rule.limitPerPeriod);
  });

  it("shares one bucket between pools and admits exactly the limit under concurrent calls", async () => {
    const clock = movableClock();
    const pools = Array.from(
      { length: 3 },
      () =>
        new pg.Pool({
          connectionString: resolveDatabaseUrl(process.env),
          options: `-c search_path=${database.schema}`,
          max: 5,
        }),
    );
    extraPools.push(...pools);
    const limiters = pools.map((pool) => createSharedRateLimiter(pool, { clock }));
    const rule = { limitPerPeriod: 7, periodMs: 60_000 };
    const decisions = await Promise.all(
      Array.from({ length: 45 }, (_, index) => {
        const limiter = limiters[index % limiters.length];
        if (limiter === undefined) {
          throw new Error("no limiter");
        }
        return limiter.take("shared", rule);
      }),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(7);
    const rows = await database.pool.query<{ count: string }>(
      "select count(*) from rate_limit_admissions where bucket = 'shared'",
    );
    expect(Number(rows.rows[0]?.count)).toBe(7);
  });

  it("keeps buckets apart and refuses malformed rules before querying", async () => {
    const clock = movableClock();
    const limiter = createSharedRateLimiter(database.pool, { clock });
    const rule = { limitPerPeriod: 1, periodMs: 1000 };
    expect((await limiter.take("a", rule)).allowed).toBe(true);
    expect((await limiter.take("b", rule)).allowed).toBe(true);
    expect((await limiter.take("a", rule)).allowed).toBe(false);
    await expect(limiter.take("a", { limitPerPeriod: 0, periodMs: 1000 })).rejects.toBeInstanceOf(
      InvalidRateLimitError,
    );
    await expect(limiter.take("a", { limitPerPeriod: 1, periodMs: 1.5 })).rejects.toBeInstanceOf(
      InvalidRateLimitError,
    );
  });

  it("resolves keyed buckets and maps a namespace quota to a window of its burst", () => {
    const rule = validateRateLimitRule("step", {
      limitPerPeriod: 2,
      periodMs: 100,
      key: (input: { readonly tenant: string }) => input.tenant,
    });
    expect(resolveRateLimitBucket("step", "step:charge", rule, { tenant: "acme" })).toBe(
      "step:charge:acme",
    );
    expect(
      resolveRateLimitBucket("step", "step:charge", { limitPerPeriod: 1, periodMs: 1 }, {}),
    ).toBe("step:charge");
    expect(() => resolveRateLimitBucket("step", "step:charge", rule, { tenant: "" })).toThrow(
      InvalidRateLimitError,
    );
    expect(quotaRateLimitRule(2, 4)).toEqual({ limitPerPeriod: 4, periodMs: 2000 });
    expect(quotaRateLimitRule(0.5, null)).toEqual({ limitPerPeriod: 1, periodMs: 2000 });
    expect(() => quotaRateLimitRule(0, null)).toThrow(InvalidRateLimitError);
  });
});
