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

  async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("condition was not met in time");
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async function terminateBackend(pid: number): Promise<void> {
    const admin = createPool(process.env, { max: 1 });
    try {
      await admin.query("select pg_terminate_backend($1)", [pid]);
    } finally {
      await admin.end();
    }
  }

  it("reports a connection that dies while a caller holds it instead of crashing", async () => {
    const errors: Error[] = [];
    pool = createPool(process.env, { max: 2, onError: (error) => errors.push(error) });
    const client = await pool.connect();
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    await terminateBackend(backend.rows[0]?.pid ?? 0);
    await waitUntil(() => errors.length > 0);
    client.release();
    expect(errors[0]).toBeInstanceOf(Error);
    const next = await pool.query<{ one: number }>("select 1 as one");
    expect(next.rows[0]?.one).toBe(1);
  });

  it("reports a connection that dies while idle and keeps serving", async () => {
    const errors: Error[] = [];
    pool = createPool(process.env, { max: 2, onError: (error) => errors.push(error) });
    const client = await pool.connect();
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    client.release();
    await terminateBackend(backend.rows[0]?.pid ?? 0);
    await waitUntil(() => errors.length > 0);
    const next = await pool.query<{ one: number }>("select 1 as one");
    expect(next.rows[0]?.one).toBe(1);
  });

  it("recovers within one failed statement when a connection died while it was held", async () => {
    pool = createPool(process.env, { max: 1 });
    const client = await pool.connect();
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    await terminateBackend(backend.rows[0]?.pid ?? 0);
    await expect(client.query("select 1")).rejects.toBeInstanceOf(Error);
    client.release();
    await pool.query("select 1").catch(() => undefined);
    const next = await pool.query<{ one: number }>("select 1 as one");
    expect(next.rows[0]?.one).toBe(1);
  });
});
