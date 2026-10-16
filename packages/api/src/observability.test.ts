import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_METRIC_NAMES, createLogger, createPool, type Logger, type Pool } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import { parsePrometheusText } from "../../core/src/observability/prometheus-text.js";
import { createApiServer, type ApiOptions } from "./server.js";

interface Running {
  readonly baseUrl: string;
  readonly key: string;
  close(): Promise<void>;
}

async function listen(pool: Pool, options: Partial<ApiOptions> = {}): Promise<Running> {
  const api = createApiServer(pool, { queueName: "default", ...options });
  await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const { port } = api.server.address() as AddressInfo;
  const key = await api.apiKeys.issue("ops").then(
    (issued) => issued.key,
    () => "",
  );
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    key,
    close: () =>
      new Promise<void>((resolve) => {
        api.server.close(() => {
          resolve();
        });
        api.server.closeAllConnections();
      }),
  };
}

describe("api operational endpoints", () => {
  let database: IsolatedSchema;
  let running: Running;
  const lines: Record<string, unknown>[] = [];
  const logger: Logger = createLogger({
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    running = await listen(database.pool, { logger });
  });

  afterAll(async () => {
    await running.close();
    await database.close();
  });

  it("answers /health and /ready with 200 and no credentials", async () => {
    const health = await fetch(`${running.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const ready = await fetch(`${running.baseUrl}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok", checks: { database: "ok" } });
  });

  it("serves /metrics in prometheus format with the eight engine metrics", async () => {
    const response = await fetch(`${running.baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const parsed = parsePrometheusText(await response.text());
    expect([...parsed.types.keys()].sort()).toEqual([...ENGINE_METRIC_NAMES].sort());
  });

  it("reflects a started run in the run counters", async () => {
    const started = await fetch(`${running.baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.key}`, "content-type": "application/json" },
      body: JSON.stringify({ workflowType: "order", input: {} }),
    });
    expect(started.status).toBe(201);
    const parsed = parsePrometheusText(await (await fetch(`${running.baseUrl}/metrics`)).text());
    const runs = parsed.samples.find(
      (entry) => entry.name === "dee_runs" && entry.labels["status"] === "RUNNING",
    );
    expect(runs?.value).toBe(1);
    const depth = parsed.samples.find(
      (entry) => entry.name === "dee_queue_depth" && entry.labels["queue"] === "default",
    );
    expect(depth?.value).toBe(1);
  });

  it("echoes a usable correlation id, logs the request under it and replaces a bad one", async () => {
    const response = await fetch(`${running.baseUrl}/health`, {
      headers: { "x-correlation-id": "req-123" },
    });
    expect(response.headers.get("x-correlation-id")).toBe("req-123");
    await response.text();
    const generated = await fetch(`${running.baseUrl}/health`, {
      headers: { "x-correlation-id": "not valid!" },
    });
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    await generated.text();
    const logged = lines.find((line) => line["correlationId"] === "req-123");
    expect(logged).toMatchObject({
      level: "info",
      message: "request completed",
      method: "GET",
      path: "/health",
      status: 200,
    });
  });

  it("keeps the unauthenticated endpoints from exposing the api", async () => {
    const response = await fetch(`${running.baseUrl}/v1/runs`);
    expect(response.status).toBe(401);
    await response.text();
  });
});

describe("api with the database down", () => {
  let running: Running;
  let deadPool: Pool;

  beforeAll(async () => {
    deadPool = createPool({ DATABASE_URL: "postgres://dee:dee@127.0.0.1:1/dee" });
    deadPool.on("error", () => undefined);
    running = await listen(deadPool, { logger: createLogger({ sink: () => undefined }) });
  });

  afterAll(async () => {
    await running.close();
    await deadPool.end();
  });

  it("returns 503 from /ready and 200 from /health", async () => {
    const ready = await fetch(`${running.baseUrl}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "unavailable", checks: { database: "failed" } });
    const health = await fetch(`${running.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("returns 503 from /metrics instead of crashing", async () => {
    const response = await fetch(`${running.baseUrl}/metrics`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "metrics_unavailable" } });
  });
});
