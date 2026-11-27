import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedSchema, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createSeverablePool, SeveredPoolError } from "./severable-pool.ts";

describe("severable pool", () => {
  let database: IsolatedSchema;

  beforeAll(async () => {
    database = await createIsolatedSchema();
  });

  afterAll(async () => {
    await database.close();
  });

  it("passes statements through until it is severed", async () => {
    const severable = createSeverablePool(database.pool);
    const result = await severable.pool.query<{ one: number }>("select 1 as one");
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it("rejects every pool statement and every new client once severed", async () => {
    const severable = createSeverablePool(database.pool);
    severable.sever();
    await expect(severable.pool.query("select 1")).rejects.toBeInstanceOf(SeveredPoolError);
    await expect(severable.pool.connect()).rejects.toBeInstanceOf(SeveredPoolError);
  });

  it("cuts a client taken before the cut, which can still be released", async () => {
    const severable = createSeverablePool(database.pool);
    const client = await severable.pool.connect();
    await client.query("select 1");
    severable.sever();
    await expect(client.query("select 1")).rejects.toBeInstanceOf(SeveredPoolError);
    client.release();
  });

  it("leaves the pool it wraps working", async () => {
    const severable = createSeverablePool(database.pool);
    severable.sever();
    const result = await database.pool.query<{ one: number }>("select 1 as one");
    expect(result.rows).toEqual([{ one: 1 }]);
  });
});
