import { afterEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { startFaultProxy, type FaultProxy } from "./fault-proxy.js";
import { databaseTarget, proxiedEnv } from "./world.js";

describe("fault proxy", () => {
  let proxy: FaultProxy | undefined;
  let pool: Pool | undefined;
  let database: IsolatedSchema | undefined;

  afterEach(async () => {
    await pool?.end();
    await proxy?.close();
    await database?.close();
    pool = undefined;
    proxy = undefined;
    database = undefined;
  });

  async function connectThroughProxy(): Promise<{ pool: Pool; proxy: FaultProxy }> {
    const target = databaseTarget();
    proxy = await startFaultProxy(target.host, target.port);
    database = await createIsolatedDatabase();
    await database.pool.query("create table pings (n integer)");
    pool = createPool(proxiedEnv(proxy.port), { schema: database.schema, max: 2 });
    return { pool, proxy };
  }

  async function pingCount(): Promise<number> {
    const result = await database?.pool.query<{ n: string }>("select count(*) as n from pings");
    return Number(result?.rows[0]?.n);
  }

  it("forwards queries to the database", async () => {
    const { pool: proxied } = await connectThroughProxy();
    const result = await proxied.query<{ one: number }>("select 1 as one");
    expect(result.rows[0]?.one).toBe(1);
  });

  it("destroys open connections on sever and lets the pool reconnect", async () => {
    const { pool: proxied, proxy: faults } = await connectThroughProxy();
    const client = await proxied.connect();
    await client.query("select 1");
    faults.sever();
    await expect(client.query("select 1")).rejects.toBeInstanceOf(Error);
    client.release();
    await proxied.query("select 1").catch(() => undefined);
    const recovered = await proxied.query<{ one: number }>("select 1 as one");
    expect(recovered.rows[0]?.one).toBe(1);
    expect(faults.severed).toBeGreaterThan(0);
  });

  it("refuses the requested number of new connections and then accepts again", async () => {
    const { pool: proxied, proxy: faults } = await connectThroughProxy();
    faults.refuseNext(2);
    const outcomes: boolean[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      outcomes.push(
        await proxied.query("select 1").then(
          () => true,
          () => false,
        ),
      );
    }
    expect(outcomes).toEqual([false, false, true]);
  });

  it("applies a commit whose response was swallowed and fails the client", async () => {
    const { pool: proxied, proxy: faults } = await connectThroughProxy();
    const client = await proxied.connect();
    await client.query("begin");
    await client.query("insert into pings (n) values (1)");
    faults.dropResponseToNextCommits(1);
    await expect(client.query("commit")).rejects.toBeInstanceOf(Error);
    client.release();
    expect(await pingCount()).toBe(1);
  });

  it("delays traffic by the configured latency", async () => {
    const { pool: proxied, proxy: faults } = await connectThroughProxy();
    await proxied.query("select 1");
    let delayed = 0;
    faults.setLatency(() => {
      delayed += 1;
      return 1;
    });
    await proxied.query("select 1");
    expect(delayed).toBeGreaterThanOrEqual(2);
  });
});
