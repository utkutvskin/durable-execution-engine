import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { createSlowDiskPool } from "./slow-pool.js";

describe("slow disk pool", () => {
  let database: IsolatedSchema;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    await database.pool.query("create table rows_written (n integer)");
  });

  afterAll(async () => {
    await database.close();
  });

  it("delays writes on the pool and on a checked out client but not reads", async () => {
    const delayed: string[] = [];
    const slow = createSlowDiskPool(database.pool, () => {
      delayed.push("delay");
      return 0;
    });
    await slow.query("select 1");
    expect(delayed).toHaveLength(0);
    await slow.query("insert into rows_written (n) values (1)");
    expect(delayed).toHaveLength(1);
    const client = await slow.connect();
    await client.query("begin");
    await client.query("update rows_written set n = 2");
    await client.query("commit");
    client.release();
    expect(delayed).toHaveLength(3);
  });

  it("returns the same rows as the pool it wraps", async () => {
    const slow = createSlowDiskPool(database.pool, () => 0);
    await slow.query("delete from rows_written");
    await slow.query("insert into rows_written (n) values ($1)", [7]);
    const result = await slow.query<{ n: number }>("select n from rows_written");
    expect(result.rows).toEqual([{ n: 7 }]);
  });
});
