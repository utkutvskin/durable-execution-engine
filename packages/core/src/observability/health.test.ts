import pg from "pg";
import { describe, expect, it } from "vitest";
import { createHealthChecks } from "./health.js";

describe("health checks", () => {
  it("reports liveness without touching the database", () => {
    const pool = new pg.Pool({ connectionString: "postgres://x:x@127.0.0.1:1/x" });
    expect(createHealthChecks(pool).live()).toEqual({ status: "ok" });
    return pool.end();
  });

  it("is ready when the database answers", async () => {
    const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;
    expect(await createHealthChecks(pool).ready()).toEqual({
      ready: true,
      checks: { database: "ok" },
    });
  });

  it("is not ready when the query fails", async () => {
    const pool = { query: () => Promise.reject(new Error("down")) } as unknown as pg.Pool;
    expect(await createHealthChecks(pool).ready()).toEqual({
      ready: false,
      checks: { database: "failed" },
    });
  });

  it("is not ready when the query hangs past the timeout", async () => {
    const pool = { query: () => new Promise<never>(() => undefined) } as unknown as pg.Pool;
    const result = await createHealthChecks(pool, { timeoutMs: 20 }).ready();
    expect(result.ready).toBe(false);
  });
});
