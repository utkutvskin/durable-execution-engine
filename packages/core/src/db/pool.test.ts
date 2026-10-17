import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";
import type { Pool } from "pg";

const env = { DATABASE_URL: "postgres://dee:dee@localhost:5432/dee" };

describe("createPool", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it("keeps the pg default idle timeout unless asked otherwise", () => {
    pool = createPool(env);
    expect(
      (pool as unknown as { options: { idleTimeoutMillis: number } }).options.idleTimeoutMillis,
    ).toBe(10_000);
  });

  it("passes an idle timeout of zero through so releases arm no timer", () => {
    pool = createPool(env, { idleTimeoutMillis: 0 });
    expect(
      (pool as unknown as { options: { idleTimeoutMillis: number } }).options.idleTimeoutMillis,
    ).toBe(0);
  });

  it("passes the pool size through", () => {
    pool = createPool(env, { max: 3 });
    expect((pool as unknown as { options: { max: number } }).options.max).toBe(3);
  });
});
