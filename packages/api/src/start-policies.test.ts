import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
  createPendingStartFirer,
  createPool,
  createQuotaStore,
  createSharedRateLimiter,
  type Pool,
} from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { validateOpenApiDocument } from "./openapi-validator.ts";
import { createQuotaGuard } from "./quota-guard.ts";
import { createRunService } from "./run-service.ts";
import { createApiServer } from "./server.ts";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Process {
  readonly baseUrl: string;
  readonly pool: Pool;
  close(): Promise<void>;
}

describe("shared rate limits and start policies over http", () => {
  let database: IsolatedSchema;
  let elapsedMs = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + elapsedMs) };
  let processes: Process[] = [];
  let key: string;
  let namespaceId: string;

  async function startProcess(): Promise<Process> {
    const pool = createPool(process.env, { schema: database.schema, max: 10 });
    const api = createApiServer(pool, {
      queueName: "default",
      service: createRunService(pool, { queueName: "default", clock }),
      quotaGuard: createQuotaGuard(pool, { limiter: createSharedRateLimiter(pool, { clock }) }),
    });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    expect(validateOpenApiDocument(api.openApiDocument)).toEqual([]);
    return {
      baseUrl: `http://127.0.0.1:${String((api.server.address() as AddressInfo).port)}`,
      pool,
      close: async () => {
        await new Promise<void>((resolve) => {
          api.server.close(() => {
            resolve();
          });
          api.server.closeAllConnections();
        });
        await pool.end();
      },
    };
  }

  async function call(
    target: Process,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function first(): Process {
    const process = processes[0];
    if (process === undefined) {
      throw new Error("no api process");
    }
    return process;
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    processes = await Promise.all([startProcess(), startProcess(), startProcess()]);
    const issuer = createApiServer(database.pool, { queueName: "default" });
    const issued = await issuer.apiKeys.issue("policies");
    key = issued.key;
    namespaceId = issued.namespaceId;
  });

  afterAll(async () => {
    await Promise.all(processes.map((process) => process.close()));
    await database.close();
  });

  it("lets three api processes together admit no more than the namespace's limit in a window", async () => {
    await createQuotaStore(database.pool).set(namespaceId, { ratePerSecond: 0.1, burst: 6 });
    onTestFinished(async () => {
      await createQuotaStore(database.pool).set(namespaceId, {});
    });
    const replies = await Promise.all(
      Array.from({ length: 36 }, (_, index) =>
        call(processes[index % processes.length] ?? first(), "GET", "/v1/runs"),
      ),
    );
    const admitted = replies.filter((reply) => reply.status === 200);
    const limited = replies.filter((reply) => reply.status === 429);
    expect(admitted).toHaveLength(6);
    expect(limited).toHaveLength(30);
    for (const reply of limited) {
      expect((reply.body["error"] as { code: string }).code).toBe("rate_limited");
    }
    elapsedMs += 60_000;
    const later = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        call(processes[index % processes.length] ?? first(), "GET", "/v1/runs"),
      ),
    );
    expect(later.filter((reply) => reply.status === 200)).toHaveLength(6);
  });

  it("answers 10 debounced starts with one pending run that starts with the last input", async () => {
    const replies: Reply[] = [];
    for (let index = 1; index <= 10; index += 1) {
      replies.push(
        await call(processes[index % processes.length] ?? first(), "POST", "/v1/runs", {
          workflowType: "sync",
          input: { version: index },
          debounce: { key: "customer-7", windowMs: 10_000 },
        }),
      );
      elapsedMs += 500;
    }
    expect(replies.map((reply) => reply.status)).toEqual(Array.from({ length: 10 }, () => 202));
    const pending = replies.map((reply) => reply.body["pending"] as { runId: string });
    expect(new Set(pending.map((entry) => entry.runId)).size).toBe(1);
    expect(replies.at(-1)?.body["pending"]).toMatchObject({
      kind: "debounce",
      key: "customer-7",
      startCount: 10,
      fireAt: new Date(Date.UTC(2026, 10, 1) + elapsedMs - 5000 + 10_000).toISOString(),
    });
    const runId = pending[0]?.runId ?? "";
    expect((await call(first(), "GET", `/v1/runs/${runId}`)).status).toBe(404);
    elapsedMs += 5000;
    const fired = await createPendingStartFirer(database.pool, { clock }).fireDue();
    expect(fired.debounced).toEqual([runId]);
    const run = await call(first(), "GET", `/v1/runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ workflowType: "sync", input: { version: 10 } });
    const listed = await call(first(), "GET", "/v1/runs?workflowType=sync");
    expect(listed.body["runs"]).toHaveLength(1);
  });

  it("opens exactly one run for 20 concurrent singleton starts across three processes", async () => {
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        call(processes[index % processes.length] ?? first(), "POST", "/v1/runs", {
          workflowType: "nightly",
          input: { n: index },
          singleton: { key: "nightly-report" },
        }),
      ),
    );
    const created = replies.filter((reply) => reply.status === 201);
    const refused = replies.filter((reply) => reply.status === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(19);
    const openRunId = (created[0]?.body["run"] as { runId: string }).runId;
    for (const reply of refused) {
      expect(reply.body["error"]).toMatchObject({
        code: "singleton_open",
        details: { key: "nightly-report", runId: openRunId },
      });
    }
    const open = await call(first(), "GET", "/v1/runs?workflowType=nightly&status=RUNNING");
    expect(open.body["runs"]).toHaveLength(1);
    const queued = await call(first(), "POST", "/v1/runs", {
      workflowType: "nightly",
      singleton: { key: "nightly-report", whenOpen: "queue" },
    });
    expect(queued.status).toBe(202);
    expect(queued.body["pending"]).toMatchObject({ kind: "singleton", fireAt: null });
  });

  it("starts a new run for an idempotency key whose TTL expired, and the same run before", async () => {
    const body = { workflowType: "charge", input: { amount: 5 }, idempotencyTtlMs: 30_000 };
    const headers = { "idempotency-key": "charge-1" };
    const created = await call(first(), "POST", "/v1/runs", body, headers);
    elapsedMs += 29_999;
    const repeated = await call(processes[1] ?? first(), "POST", "/v1/runs", body, headers);
    elapsedMs += 1;
    const renewed = await call(processes[2] ?? first(), "POST", "/v1/runs", body, headers);
    expect([created.status, repeated.status, renewed.status]).toEqual([201, 200, 201]);
    const createdRun = created.body["run"] as { runId: string };
    const renewedRun = renewed.body["run"] as { runId: string; idempotencyKey: string };
    expect((repeated.body["run"] as { runId: string }).runId).toBe(createdRun.runId);
    expect(renewedRun.runId).not.toBe(createdRun.runId);
    expect(renewedRun.idempotencyKey).toBe("charge-1");
    const old = await call(first(), "GET", `/v1/runs/${createdRun.runId}`);
    expect(old.body["idempotencyKey"]).toBeNull();
  });

  it("refuses unsupported policy combinations and a TTL without a key", async () => {
    const combined = await call(first(), "POST", "/v1/runs", {
      workflowType: "sync",
      debounce: { key: "k", windowMs: 100 },
      singleton: { key: "k" },
    });
    const ttlOnly = await call(first(), "POST", "/v1/runs", {
      workflowType: "sync",
      idempotencyTtlMs: 100,
    });
    const malformed = await call(first(), "POST", "/v1/runs", {
      workflowType: "sync",
      singleton: { key: "k", whenOpen: "later" },
    });
    expect([combined.status, ttlOnly.status, malformed.status]).toEqual([400, 400, 400]);
    expect((combined.body["error"] as { code: string }).code).toBe("invalid_start_policy");
    expect((ttlOnly.body["error"] as { code: string }).code).toBe("invalid_start_policy");
    expect((malformed.body["error"] as { code: string }).code).toBe("validation_failed");
  });
});
