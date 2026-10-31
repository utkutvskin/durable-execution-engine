import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";
import { createIsolatedSchema, type IsolatedSchema } from "./test-harness.js";
import { withClient, withTransaction } from "./transaction.js";

describe("transactions and broken clients", () => {
  let database: IsolatedSchema;

  beforeAll(async () => {
    database = await createIsolatedSchema();
    await database.pool.query("create table item (id int primary key)");
  });

  afterAll(async () => {
    await database.close();
  });

  it("commits what the work wrote", async () => {
    await withTransaction(database.pool, async (client) => {
      await client.query("insert into item (id) values (1)");
    });

    const rows = await database.pool.query("select id from item where id = 1");
    expect(rows.rowCount).toBe(1);
  });

  it("rolls back and rethrows when the work throws", async () => {
    await expect(
      withTransaction(database.pool, async (client) => {
        await client.query("insert into item (id) values (2)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await database.pool.query("select id from item where id = 2");
    expect(rows.rowCount).toBe(0);
  });

  it("does not reuse a client whose connection died", async () => {
    const pool = createPool(process.env, {
      schema: database.schema,
      max: 1,
      acquireTimeoutMillis: 5_000,
    });
    const firstPid = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
      ?.pid;

    await expect(
      withClient(pool, async (client) => {
        const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
          ?.pid;
        await database.pool.query("select pg_terminate_backend($1)", [pid]);
        await client.query("select 1");
      }),
    ).rejects.toThrow();

    const next = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    expect(next.rows[0]?.pid).not.toBe(firstPid);
    await pool.end();
  });

  it("returns a healthy client to the pool after a failed statement", async () => {
    const pool = createPool(process.env, { schema: database.schema, max: 1 });
    const firstPid = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
      ?.pid;

    await expect(
      withTransaction(pool, async (client) => {
        await client.query("insert into item (id) values (1)");
      }),
    ).rejects.toThrow();

    const next = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    expect(next.rows[0]?.pid).toBe(firstPid);
    await pool.end();
  });

  it("fails a connect that waits longer than the acquire timeout", async () => {
    const pool = createPool(process.env, {
      schema: database.schema,
      max: 1,
      acquireTimeoutMillis: 50,
    });
    const held = await pool.connect();

    await expect(pool.connect()).rejects.toThrow(/timeout/i);

    held.release();
    await pool.end();
  });
});
