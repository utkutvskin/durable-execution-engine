import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQuotaStore, createRateLimiter, createTaskQueue } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import { validateOpenApiDocument } from "./openapi-validator.js";
import { createQuotaGuard } from "./quota-guard.js";
import { createApiServer } from "./server.js";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

describe("quotas and rate limiting over http", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let elapsedMs = 0;
  let namespaceA: { key: string; namespaceId: string };
  let namespaceB: { key: string; namespaceId: string };
  let namespaceC: { key: string; namespaceId: string };
  const quotas = () => createQuotaStore(database.pool);

  async function call(
    key: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Reply> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      headers: response.headers,
    };
  }

  async function start(key: string): Promise<Reply> {
    return call(key, "POST", "/v1/runs", { workflowType: "order", input: {} });
  }

  function runIdOf(reply: Reply): string {
    return (reply.body["run"] as { runId: string }).runId;
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const clock = { now: () => new Date(Date.UTC(2026, 2, 1) + elapsedMs) };
    const guard = createQuotaGuard(database.pool, {
      limiter: createRateLimiter({ clock }),
      queueName: "default",
      maxQueueDepth: 50,
    });
    const api = createApiServer(database.pool, { queueName: "default", quotaGuard: guard });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${String((api.server.address() as AddressInfo).port)}`;
    closeServer = () =>
      new Promise<void>((resolve) => {
        api.server.close(() => {
          resolve();
        });
        api.server.closeAllConnections();
      });
    namespaceA = await api.apiKeys.issue("quota-a");
    namespaceB = await api.apiKeys.issue("quota-b");
    namespaceC = await api.apiKeys.issue("quota-c");
    expect(validateOpenApiDocument(api.openApiDocument)).toEqual([]);
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("answers 429 with Retry-After once a namespace spends its burst while another namespace is unaffected", async () => {
    await quotas().set(namespaceA.namespaceId, { ratePerSecond: 1, burst: 3 });
    await quotas().set(namespaceB.namespaceId, { ratePerSecond: 1, burst: 3 });
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      statuses.push((await call(namespaceA.key, "GET", "/v1/runs")).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const refused = await call(namespaceA.key, "GET", "/v1/runs");
    expect(refused.headers.get("retry-after")).toBe("1");
    expect((refused.body["error"] as { code: string }).code).toBe("rate_limited");

    expect((await call(namespaceB.key, "GET", "/v1/runs")).status).toBe(200);
    expect((await start(namespaceB.key)).status).toBe(201);
  });

  it("lets the namespace through again once the bucket has refilled", async () => {
    elapsedMs += 2000;
    expect((await call(namespaceA.key, "GET", "/v1/runs")).status).toBe(200);
    expect((await call(namespaceA.key, "GET", "/v1/runs")).status).toBe(200);
    expect((await call(namespaceA.key, "GET", "/v1/runs")).status).toBe(429);
  });

  it("refuses a start over the concurrent run quota, still serves reads, and frees the slot when a run closes", async () => {
    await quotas().set(namespaceC.namespaceId, { maxConcurrentRuns: 2 });
    const first = await start(namespaceC.key);
    const second = await start(namespaceC.key);
    expect([first.status, second.status]).toEqual([201, 201]);

    const third = await start(namespaceC.key);
    expect(third.status).toBe(429);
    expect((third.body["error"] as { code: string }).code).toBe("run_quota_exceeded");
    expect(third.headers.get("retry-after")).toBe("5");
    expect((await call(namespaceC.key, "GET", "/v1/runs")).status).toBe(200);

    const terminated = await call(
      namespaceC.key,
      "POST",
      `/v1/runs/${runIdOf(first)}/terminate`,
      {},
    );
    expect(terminated.status).toBe(200);
    expect((await start(namespaceC.key)).status).toBe(201);
  });

  it("refuses writes over the pending task quota but not reads", async () => {
    await quotas().set(namespaceC.namespaceId, { maxPendingTasks: 1 });
    const usage = await quotas().usage(namespaceC.namespaceId);
    expect(usage.pendingTasks).toBeGreaterThanOrEqual(1);

    const runs = await call(namespaceC.key, "GET", "/v1/runs");
    const anyRun = (runs.body["runs"] as { runId: string }[])[0]?.runId ?? "";
    const signal = await call(namespaceC.key, "POST", `/v1/runs/${anyRun}/signal`, {
      name: "go",
    });
    expect(signal.status).toBe(429);
    expect((signal.body["error"] as { code: string }).code).toBe("task_quota_exceeded");
    expect((await call(namespaceC.key, "GET", `/v1/runs/${anyRun}`)).status).toBe(200);
  });

  it("does not let one namespace's quota block another namespace's writes", async () => {
    await quotas().set(namespaceC.namespaceId, { maxPendingTasks: 0 });
    expect((await start(namespaceC.key)).status).toBe(429);
    await quotas().set(namespaceB.namespaceId, { ratePerSecond: 1000, burst: 1000 });
    expect((await start(namespaceB.key)).status).toBe(201);
  });

  it("applies backpressure with 503 while the queue is deep and recovers when it drains", async () => {
    await quotas().set(namespaceB.namespaceId, {});
    const queue = createTaskQueue(database.pool);
    const run = await start(namespaceB.key);
    const filler = runIdOf(run);
    const current = await quotas().queueDepth("default");
    for (let index = current; index < 50; index += 1) {
      await queue.enqueue({
        namespaceId: namespaceB.namespaceId,
        runId: filler,
        queueName: "default",
        taskType: "STEP_TASK",
      });
    }

    const refused = await start(namespaceB.key);
    expect(refused.status).toBe(503);
    expect((refused.body["error"] as { code: string }).code).toBe("overloaded");
    expect(refused.headers.get("retry-after")).toBe("5");
    expect((await call(namespaceB.key, "GET", "/v1/runs")).status).toBe(200);

    const leased = await queue.dequeue({
      queueName: "default",
      visibilityTimeoutMs: 60_000,
      limit: 10,
    });
    expect(leased).toHaveLength(10);
    expect((await start(namespaceB.key)).status).toBe(201);
  });
});
