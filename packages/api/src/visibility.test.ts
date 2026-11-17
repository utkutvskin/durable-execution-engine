import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { createApiServer } from "./server.ts";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface ListedRun {
  readonly runId: string;
  readonly status: string;
  readonly searchAttributes: Record<string, unknown>;
  readonly memo: unknown;
}

describe("visibility queries over http", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let key: string;
  let otherKey: string;
  let closeServer: () => Promise<void>;

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    apiKey = key,
  ): Promise<Reply> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function start(searchAttributes: Record<string, unknown>, memo?: unknown): Promise<string> {
    const started = await call("POST", "/v1/runs", {
      workflowType: "order",
      searchAttributes,
      ...(memo === undefined ? {} : { memo }),
    });
    expect(started.status).toBe(201);
    return (started.body["run"] as { runId: string }).runId;
  }

  async function search(query: string, apiKey = key): Promise<Reply> {
    return call("GET", `/v1/runs?query=${encodeURIComponent(query)}`, undefined, apiKey);
  }

  function idsOf(reply: Reply): string[] {
    return (reply.body["runs"] as ListedRun[]).map((run) => run.runId).sort();
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const api = createApiServer(database.pool, { queueName: "default" });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    const { port } = api.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(port)}`;
    closeServer = () =>
      new Promise<void>((resolve) => {
        api.server.close(() => {
          resolve();
        });
        api.server.closeAllConnections();
      });
    key = (await api.apiKeys.issue("visibility")).key;
    otherKey = (await api.apiKeys.issue("elsewhere")).key;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("starts a run with search attributes and a memo and shows both", async () => {
    const runId = await start({ customerId: "c-7", amount: 12 }, { note: "gift wrap" });
    const described = await call("GET", `/v1/runs/${runId}`);
    expect(described.body).toMatchObject({
      runId,
      searchAttributes: { customerId: "c-7", amount: 12 },
      memo: { note: "gift wrap" },
    });
    const listed = await search("customerId = 'c-7'");
    expect(listed.body["runs"]).toEqual([
      expect.objectContaining({
        runId,
        searchAttributes: { customerId: "c-7", amount: 12 },
        memo: { note: "gift wrap" },
      }),
    ]);
  });

  it("filters on status, attributes and start time together", async () => {
    const failed = await start({ customerId: "c-1", amount: 50 });
    const cheap = await start({ customerId: "c-1", amount: 5 });
    await start({ customerId: "c-2", amount: 50 });
    await database.pool.query(
      "update workflow_runs set status = 'FAILED', closed_at = now() where id = any($1::uuid[])",
      [[failed, cheap]],
    );
    const since = new Date(Date.now() - 60_000).toISOString();
    const reply = await search(
      `status = 'FAILED' and customerId = 'c-1' and startedAt > '${since}' and amount >= 10`,
    );
    expect(reply.status).toBe(200);
    expect(idsOf(reply)).toEqual([failed]);
    expect(idsOf(await search(`startedAt > '2999-01-01T00:00:00Z'`))).toEqual([]);
    const combined = await call(
      "GET",
      `/v1/runs?status=FAILED&query=${encodeURIComponent("amount < 10")}`,
    );
    expect(idsOf(combined)).toEqual([cheap]);
  });

  it("keeps a query inside the caller's namespace", async () => {
    await start({ customerId: "c-ns" });
    expect(idsOf(await search("customerId = 'c-ns'"))).toHaveLength(1);
    expect(idsOf(await search("customerId = 'c-ns'", otherKey))).toEqual([]);
  });

  it.each([
    ["status = 'FAILED' and", 22],
    ["customerId = 'c-1", 14],
    ["status = 'NOPE'", 10],
    ["amount >> 5", 9],
    ["status = 'FAILED'; drop table workflow_runs", 18],
    ["1 = 1 or status = 'FAILED'", 1],
    ["customerId = 'a' union select key_hash from api_keys", 18],
  ])("answers %j with 400 invalid_query naming position %i", async (query, position) => {
    const reply = await search(query);
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({
      error: {
        code: "invalid_query",
        message: expect.stringContaining(`at position ${String(position)}`) as string,
        details: { position },
      },
    });
  });

  it("binds a quoted injection attempt as a value and leaves every table in place", async () => {
    const reply = await search("customerId = 'x'' or 1=1; drop table workflow_runs; --'");
    expect(reply.status).toBe(200);
    expect(reply.body["runs"]).toEqual([]);
    const runs = await database.pool.query("select count(*) from workflow_runs");
    expect(Number((runs.rows[0] as { count: string }).count)).toBeGreaterThan(0);
  });

  it("refuses invalid search attributes at start with 400 and writes no run", async () => {
    const before = await database.pool.query("select count(*) from workflow_runs");
    const reserved = await call("POST", "/v1/runs", {
      workflowType: "order",
      searchAttributes: { status: "x" },
    });
    const nested = await call("POST", "/v1/runs", {
      workflowType: "order",
      searchAttributes: { customer: { id: 1 } },
    });
    expect(reserved.status).toBe(400);
    expect(reserved.body["error"]).toMatchObject({ code: "invalid_search_attributes" });
    expect(nested.status).toBe(400);
    const after = await database.pool.query("select count(*) from workflow_runs");
    expect(after.rows).toEqual(before.rows);
  });

  it("starts a run with a priority its task inherits and refuses one out of range", async () => {
    const started = await call("POST", "/v1/runs", { workflowType: "order", priority: 25 });
    expect(started.status).toBe(201);
    const runId = (started.body["run"] as { runId: string }).runId;
    const stored = await database.pool.query<{ run: number; task: number }>(
      `select r.priority as run, t.priority as task
       from workflow_runs r join tasks t on t.run_id = r.id where r.id = $1`,
      [runId],
    );
    expect(stored.rows).toEqual([{ run: 25, task: 25 }]);
    const before = await database.pool.query("select count(*) from workflow_runs");
    const tooHigh = await call("POST", "/v1/runs", { workflowType: "order", priority: 1001 });
    const fractional = await call("POST", "/v1/runs", { workflowType: "order", priority: 1.5 });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body["error"]).toMatchObject({ code: "validation_failed" });
    expect(fractional.status).toBe(400);
    const after = await database.pool.query("select count(*) from workflow_runs");
    expect(after.rows).toEqual(before.rows);
  });

  it("pages through query results with the cursor", async () => {
    for (let index = 0; index < 5; index += 1) {
      await start({ batch: "paged" });
    }
    const first = await call(
      "GET",
      `/v1/runs?limit=3&query=${encodeURIComponent("batch = 'paged'")}`,
    );
    const cursor = first.body["nextCursor"] as string;
    const second = await call(
      "GET",
      `/v1/runs?limit=3&cursor=${encodeURIComponent(cursor)}&query=${encodeURIComponent("batch = 'paged'")}`,
    );
    expect(idsOf(first)).toHaveLength(3);
    expect(idsOf(second)).toHaveLength(2);
    expect(second.body["nextCursor"]).toBeUndefined();
  });
});
