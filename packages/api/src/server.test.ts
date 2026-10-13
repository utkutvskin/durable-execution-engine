import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import { validateOpenApiDocument } from "./openapi-validator.js";
import { createApiServer } from "./server.js";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

describe("http api", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let keyA: string;
  let keyB: string;
  let issueKey: (namespace: string) => Promise<string>;

  async function call(
    key: string | undefined,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: parsed, headers: response.headers };
  }

  async function startRun(
    key: string,
    workflowType = "order",
    input: unknown = { n: 1 },
    headers: Record<string, string> = {},
  ): Promise<string> {
    const reply = await call(key, "POST", "/v1/runs", { workflowType, input }, headers);
    expect(reply.status).toBe(201);
    return (reply.body["run"] as { runId: string }).runId;
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
    issueKey = async (namespace) => (await api.apiKeys.issue(namespace)).key;
    keyA = await issueKey("namespace-a");
    keyB = await issueKey("namespace-b");
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  describe("authentication", () => {
    it("answers 401 with a challenge when no key is sent", async () => {
      const reply = await call(undefined, "GET", "/v1/runs");
      expect(reply.status).toBe(401);
      expect(reply.headers.get("www-authenticate")).toBe('Bearer realm="dee"');
      expect((reply.body["error"] as { code: string }).code).toBe("unauthorized");
    });

    it("answers 401 for an unknown key", async () => {
      expect((await call("dee_nope", "GET", "/v1/runs")).status).toBe(401);
    });

    it("answers 401 for a revoked key", async () => {
      const issued = await createApiServer(database.pool, { queueName: "default" }).apiKeys.issue(
        "revoked-ns",
      );
      expect((await call(issued.key, "GET", "/v1/runs")).status).toBe(200);
      await database.pool.query("update api_keys set revoked_at = now() where id = $1", [
        issued.keyId,
      ]);
      expect((await call(issued.key, "GET", "/v1/runs")).status).toBe(401);
    });

    it("serves the openapi document without a key", async () => {
      const reply = await call(undefined, "GET", "/openapi.json");
      expect(reply.status).toBe(200);
      expect(validateOpenApiDocument(reply.body)).toEqual([]);
    });
  });

  describe("namespace isolation", () => {
    let foreignRunId: string;

    beforeAll(async () => {
      foreignRunId = await startRun(keyB, "private-flow", { secret: true });
    });

    const attempts: readonly {
      name: string;
      method: "GET" | "POST";
      path: (runId: string) => string;
      body?: unknown;
    }[] = [
      { name: "describeRun", method: "GET", path: (id) => `/v1/runs/${id}` },
      { name: "getHistory", method: "GET", path: (id) => `/v1/runs/${id}/history` },
      {
        name: "signalRun",
        method: "POST",
        path: (id) => `/v1/runs/${id}/signal`,
        body: { name: "go" },
      },
      { name: "cancelRun", method: "POST", path: (id) => `/v1/runs/${id}/cancel`, body: {} },
      {
        name: "terminateRun",
        method: "POST",
        path: (id) => `/v1/runs/${id}/terminate`,
        body: {},
      },
    ];

    for (const attempt of attempts) {
      it(`${attempt.name} on namespace b's run with namespace a's key returns 404`, async () => {
        const reply = await call(keyA, attempt.method, attempt.path(foreignRunId), attempt.body);
        expect(reply.status).toBe(404);
        expect((reply.body["error"] as { code: string }).code).toBe("not_found");
      });
    }

    it("listRuns never shows another namespace's runs", async () => {
      const own = await startRun(keyA, "own-flow");
      const reply = await call(keyA, "GET", "/v1/runs?limit=200");
      const ids = (reply.body["runs"] as { runId: string }[]).map((run) => run.runId);
      expect(ids).toContain(own);
      expect(ids).not.toContain(foreignRunId);
    });

    it("startRun with namespace a's key and a reused idempotency key of b does not return b's run", async () => {
      const idempotency = { "idempotency-key": "cross-namespace" };
      const first = await startRun(keyB, "keyed", { x: 1 }, idempotency);
      const second = await startRun(keyA, "keyed", { x: 1 }, idempotency);
      expect(second).not.toBe(first);
    });

    it("leaves the foreign run untouched after every rejected call", async () => {
      const described = await call(keyB, "GET", `/v1/runs/${foreignRunId}`);
      expect((described.body as { status: string }).status).toBe("RUNNING");
      const history = await call(keyB, "GET", `/v1/runs/${foreignRunId}/history`);
      expect(history.body["events"]).toHaveLength(1);
    });

    it("treats a malformed run id exactly like a missing run", async () => {
      expect((await call(keyA, "GET", "/v1/runs/not-a-uuid")).status).toBe(404);
      expect(
        (await call(keyA, "GET", "/v1/runs/00000000-0000-4000-8000-000000000000")).status,
      ).toBe(404);
    });
  });

  describe("idempotent start", () => {
    it("creates one run for two starts with the same idempotency key", async () => {
      const headers = { "idempotency-key": "order-1001" };
      const first = await call(
        keyA,
        "POST",
        "/v1/runs",
        { workflowType: "pay", input: 5 },
        headers,
      );
      const second = await call(
        keyA,
        "POST",
        "/v1/runs",
        { workflowType: "pay", input: 5 },
        headers,
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body["created"]).toBe(false);
      expect((second.body["run"] as { runId: string }).runId).toBe(
        (first.body["run"] as { runId: string }).runId,
      );
      const rows = await database.pool.query(
        "select 1 from workflow_runs where idempotency_key = 'order-1001'",
      );
      expect(rows.rowCount).toBe(1);
      const tasks = await database.pool.query("select 1 from tasks where run_id = $1", [
        (first.body["run"] as { runId: string }).runId,
      ]);
      expect(tasks.rowCount).toBe(1);
    });

    it("creates one run for ten concurrent starts with the same key", async () => {
      const headers = { "idempotency-key": "burst" };
      const replies = await Promise.all(
        Array.from({ length: 10 }, () =>
          call(keyA, "POST", "/v1/runs", { workflowType: "pay", input: 1 }, headers),
        ),
      );
      const ids = new Set(replies.map((reply) => (reply.body["run"] as { runId: string }).runId));
      expect(ids.size).toBe(1);
      expect(replies.filter((reply) => reply.status === 201)).toHaveLength(1);
      const events = await database.pool.query("select 1 from run_events where run_id = $1", [
        [...ids][0],
      ]);
      expect(events.rowCount).toBe(1);
    });

    it("answers 409 when the key is reused for a different request", async () => {
      const headers = { "idempotency-key": "changed" };
      await startRun(keyA, "pay", { amount: 1 }, headers);
      const reply = await call(
        keyA,
        "POST",
        "/v1/runs",
        { workflowType: "pay", input: { amount: 2 } },
        headers,
      );
      expect(reply.status).toBe(409);
      expect((reply.body["error"] as { code: string }).code).toBe("idempotency_conflict");
    });

    it("starts a new run every time when no key is sent", async () => {
      const first = await startRun(keyA, "plain");
      const second = await startRun(keyA, "plain");
      expect(first).not.toBe(second);
    });
  });

  describe("endpoints", () => {
    it("startRun records run_started and a workflow task, and describeRun shows the run", async () => {
      const runId = await startRun(keyA, "ship", { order: 7 });
      const described = await call(keyA, "GET", `/v1/runs/${runId}`);
      expect(described.status).toBe(200);
      expect(described.body).toMatchObject({
        runId,
        workflowType: "ship",
        status: "RUNNING",
        input: { order: 7 },
        closedAt: null,
      });
      const history = await call(keyA, "GET", `/v1/runs/${runId}/history`);
      expect(history.body["events"]).toMatchObject([
        { sequenceNumber: 1, event: { type: "run_started", workflowType: "ship" } },
      ]);
      const task = await database.pool.query<{ task_type: string; payload: unknown }>(
        "select task_type, payload from tasks where run_id = $1",
        [runId],
      );
      expect(task.rows).toEqual([{ task_type: "WORKFLOW_TASK", payload: { reason: "start" } }]);
    });

    it("signalRun appends signal_received to the history", async () => {
      const runId = await startRun(keyA);
      const reply = await call(keyA, "POST", `/v1/runs/${runId}/signal`, {
        name: "approve",
        payload: { by: "ada" },
      });
      expect(reply.status).toBe(200);
      expect(reply.body["sequenceNumber"]).toBe(2);
      const history = await call(keyA, "GET", `/v1/runs/${runId}/history`);
      expect((history.body["events"] as { event: unknown }[])[1]?.event).toMatchObject({
        type: "signal_received",
        signalName: "approve",
        payload: { by: "ada" },
      });
    });

    it("cancelRun answers 202 and records cancel_requested", async () => {
      const runId = await startRun(keyA);
      const reply = await call(keyA, "POST", `/v1/runs/${runId}/cancel`, {
        reason: "no longer needed",
      });
      expect(reply.status).toBe(202);
      expect(reply.body["requested"]).toBe(true);
      const history = await call(keyA, "GET", `/v1/runs/${runId}/history`);
      expect(
        (history.body["events"] as { event: { type: string } }[]).map((e) => e.event.type),
      ).toEqual(["run_started", "cancel_requested"]);
    });

    it("terminateRun closes the run and later signals answer 409", async () => {
      const runId = await startRun(keyA);
      const reply = await call(keyA, "POST", `/v1/runs/${runId}/terminate`, { reason: "abuse" });
      expect(reply.status).toBe(200);
      const described = await call(keyA, "GET", `/v1/runs/${runId}`);
      expect(described.body["status"]).toBe("TERMINATED");
      const signal = await call(keyA, "POST", `/v1/runs/${runId}/signal`, { name: "late" });
      expect(signal.status).toBe(409);
      const again = await call(keyA, "POST", `/v1/runs/${runId}/terminate`, {});
      expect(again.status).toBe(409);
    });

    it("listRuns filters by status and workflow type", async () => {
      const namespaceKey = await issueKey("filters");
      const kept = await startRun(namespaceKey, "alpha");
      const stopped = await startRun(namespaceKey, "beta");
      await call(namespaceKey, "POST", `/v1/runs/${stopped}/terminate`, {});
      const running = await call(namespaceKey, "GET", "/v1/runs?status=RUNNING");
      expect((running.body["runs"] as { runId: string }[]).map((run) => run.runId)).toEqual([kept]);
      const beta = await call(namespaceKey, "GET", "/v1/runs?workflowType=beta");
      expect((beta.body["runs"] as { runId: string }[]).map((run) => run.runId)).toEqual([stopped]);
    });

    it("listRuns pages through every run newest first without repeats", async () => {
      const namespaceKey = await issueKey("paging");
      const started: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        started.push(await startRun(namespaceKey, "paged", { index }));
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const query = `/v1/runs?limit=3${cursor === undefined ? "" : `&cursor=${cursor}`}`;
        const reply = await call(namespaceKey, "GET", query);
        seen.push(...(reply.body["runs"] as { runId: string }[]).map((run) => run.runId));
        cursor = reply.body["nextCursor"] as string | undefined;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(seen).toEqual([...started].reverse());
    });
  });

  describe("request validation", () => {
    it("answers 400 with details for an invalid start body", async () => {
      const reply = await call(keyA, "POST", "/v1/runs", { workflowType: "" });
      expect(reply.status).toBe(400);
      expect((reply.body["error"] as { code: string }).code).toBe("validation_failed");
    });

    it("answers 400 for a body that is not json", async () => {
      const response = await fetch(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
        body: "{broken",
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "invalid_json",
      );
    });

    it("answers 400 for an out of range limit and a malformed cursor", async () => {
      expect((await call(keyA, "GET", "/v1/runs?limit=0")).status).toBe(400);
      expect((await call(keyA, "GET", "/v1/runs?limit=201")).status).toBe(400);
      const cursor = await call(keyA, "GET", "/v1/runs?cursor=garbage");
      expect(cursor.status).toBe(400);
      expect((cursor.body["error"] as { code: string }).code).toBe("invalid_cursor");
    });

    it("answers 400 for an unknown status filter and a signal without a name", async () => {
      expect((await call(keyA, "GET", "/v1/runs?status=BOGUS")).status).toBe(400);
      const runId = await startRun(keyA);
      expect((await call(keyA, "POST", `/v1/runs/${runId}/signal`, {})).status).toBe(400);
    });

    it("answers 413 when the body exceeds the limit", async () => {
      const api = createApiServer(database.pool, { queueName: "default", maxBodyBytes: 64 });
      await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
      const { port } = api.server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${String(port)}/v1/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
        body: JSON.stringify({ workflowType: "big", input: "x".repeat(500) }),
      });
      expect(response.status).toBe(413);
      api.server.closeAllConnections();
      api.server.close();
    });

    it("answers 404 for an unknown endpoint and 405 for a wrong method", async () => {
      expect((await call(keyA, "GET", "/v2/nothing")).status).toBe(404);
      const runId = await startRun(keyA);
      const reply = await call(keyA, "POST", `/v1/runs/${runId}`, {});
      expect(reply.status).toBe(405);
      expect(reply.headers.get("allow")).toBe("GET");
    });
  });
});
