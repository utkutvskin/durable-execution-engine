import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BATCH_WORKFLOW_TYPE } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { validateOpenApiDocument } from "./openapi-validator.ts";
import { createApiServer } from "./server.ts";
import { issueTestKey } from "./test-keys.ts";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

describe("reset, fork and batches over http", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let key: string;
  let readKey: string;
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

  async function start(tag: string): Promise<string> {
    const started = await call("POST", "/v1/runs", {
      workflowType: "order",
      input: { tag },
      searchAttributes: { tag },
    });
    expect(started.status).toBe(201);
    return (started.body["run"] as { runId: string }).runId;
  }

  function errorCode(reply: Reply): string {
    return (reply.body["error"] as { code: string }).code;
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const api = createApiServer(database.pool, { queueName: "default" });
    expect(validateOpenApiDocument(api.openApiDocument)).toEqual([]);
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
    key = (await issueTestKey(api.apiKeys, "resets", { scope: "operate" })).key;
    readKey = (await issueTestKey(api.apiKeys, "resets", { scope: "read" })).key;
    otherKey = (await issueTestKey(api.apiKeys, "elsewhere")).key;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("resets an open run to its first event, terminating it, and lists its cuts", async () => {
    const runId = await start("reset-me");
    const points = await call("GET", `/v1/runs/${runId}/reset-points`);
    expect(points).toEqual({
      status: 200,
      body: { points: [{ sequence: 1, eventType: "run_started" }] },
    });

    const reset = await call("POST", `/v1/runs/${runId}/reset`, {
      point: { kind: "event", sequence: 1 },
      reason: "bad deploy",
    });
    expect(reset.status).toBe(201);
    expect(reset.body).toMatchObject({
      resetFromRunId: runId,
      kind: "reset",
      eventSequence: 1,
      terminatedOriginal: true,
    });
    const original = await call("GET", `/v1/runs/${runId}`);
    expect(original.body["status"]).toBe("TERMINATED");
    const audit = await database.pool.query<{ action: string; target: string | null }>(
      "select action, target from audit_log where action = 'run.reset'",
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("answers 409 for a cut the history cannot take, 404 for another namespace's run", async () => {
    const runId = await start("bad-cut");
    const beyond = await call("POST", `/v1/runs/${runId}/fork`, {
      point: { kind: "event", sequence: 5 },
    });
    expect(beyond.status).toBe(409);
    expect(errorCode(beyond)).toBe("invalid_reset_point");
    const elsewhere = await call(
      "POST",
      `/v1/runs/${runId}/fork`,
      { point: { kind: "event", sequence: 1 } },
      otherKey,
    );
    expect(elsewhere.status).toBe(404);
    const malformed = await call("POST", `/v1/runs/${runId}/fork`, { point: { kind: "nope" } });
    expect(malformed.status).toBe(400);
  });

  it("starts a batch over a query and reports it and its targets", async () => {
    const first = await start("batch-me");
    const second = await start("batch-me");
    await start("leave-me");

    const started = await call("POST", "/v1/batches", {
      operation: "signal",
      query: "tag = 'batch-me'",
      signal: { name: "go", payload: { now: true } },
      runsPerSecond: 50,
    });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      operation: "signal",
      total: 2,
      remaining: 2,
      pageSize: 50,
      pageIntervalMs: 1000,
      status: "RUNNING",
    });
    const batchId = started.body["batchId"] as string;

    const read = await call("GET", `/v1/batches/${batchId}`);
    expect(read.body).toMatchObject({ batchId, total: 2 });
    const listed = await call("GET", "/v1/batches");
    expect((listed.body["batches"] as { batchId: string }[]).map((b) => b.batchId)).toContain(
      batchId,
    );
    const targets = await call("GET", `/v1/batches/${batchId}/targets?limit=10`);
    expect(
      (targets.body["targets"] as { runId: string; state: string }[]).map((t) => [
        t.runId,
        t.state,
      ]),
    ).toEqual([
      [first, "PENDING"],
      [second, "PENDING"],
    ]);
    const batchRun = await call("GET", `/v1/runs/${started.body["runId"] as string}`);
    expect(batchRun.body["workflowType"]).toBe(BATCH_WORKFLOW_TYPE);
    expect((await call("GET", `/v1/batches/${batchId}`, undefined, otherKey)).status).toBe(404);
  });

  it("refuses a malformed batch with a 400 and a read key with a 403", async () => {
    const noSignal = await call("POST", "/v1/batches", { operation: "signal", query: "" });
    expect(noSignal.status).toBe(400);
    expect(errorCode(noSignal)).toBe("invalid_batch");
    const badQuery = await call("POST", "/v1/batches", { operation: "cancel", query: "tag =" });
    expect(badQuery.status).toBe(400);
    const readOnly = await call("POST", "/v1/batches", { operation: "cancel", query: "" }, readKey);
    expect(readOnly.status).toBe(403);
    const resetByRead = await call(
      "POST",
      `/v1/runs/${await start("read-only")}/reset`,
      { point: { kind: "event", sequence: 1 } },
      readKey,
    );
    expect(resetByRead.status).toBe(403);
  });
});
