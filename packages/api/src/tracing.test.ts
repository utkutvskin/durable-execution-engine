import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import { createTracingProvider, parseTraceparent, type TracingProvider } from "@dee/core";
import { createApiServer } from "./server.js";

interface ExportedSpan {
  readonly name: string;
  readonly spanContext: () => { traceId: string; spanId: string };
  readonly parentSpanContext?: { spanId: string };
  readonly attributes: Record<string, unknown>;
}

describe("api tracing", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let key: string;
  let provider: TracingProvider;
  let closeServer: () => Promise<void>;
  const exported: ExportedSpan[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    provider = createTracingProvider({
      serviceName: "api-test",
      exporter: {
        export(spans, done) {
          exported.push(...(spans as unknown as ExportedSpan[]));
          done({ code: 0 });
        },
        shutdown: () => Promise.resolve(),
      },
    });
    const api = createApiServer(database.pool, { queueName: "default", tracing: provider.tracing });
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
    key = (await api.apiKeys.issue("traced")).key;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  async function start(headers: Record<string, string> = {}): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ workflowType: "order", input: {} }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { run: { runId: string } };
    await provider.forceFlush();
    return body.run.runId;
  }

  async function storedTraceparent(runId: string): Promise<string | null> {
    const row = await database.pool.query<{ traceparent: string | null }>(
      "select traceparent from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0]?.traceparent ?? null;
  }

  it("starts a new trace for a request without a traceparent and stores its context", async () => {
    const runId = await start();
    const stored = parseTraceparent(await storedTraceparent(runId));
    const span = exported.find((candidate) => candidate.attributes["dee.run.id"] === runId);
    expect(span?.name).toBe("workflow.start");
    expect(span?.parentSpanContext).toBeUndefined();
    expect(stored?.traceId).toBe(span?.spanContext().traceId);
    expect(stored?.spanId).toBe(span?.spanContext().spanId);
  });

  it("continues the trace of the caller's traceparent header", async () => {
    const caller = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
    const runId = await start({ traceparent: caller });
    const span = exported.find((candidate) => candidate.attributes["dee.run.id"] === runId);
    expect(span?.spanContext().traceId).toBe("ab".repeat(16));
    expect(span?.parentSpanContext?.spanId).toBe("cd".repeat(8));
    expect(parseTraceparent(await storedTraceparent(runId))?.traceId).toBe("ab".repeat(16));
  });

  it("ignores a malformed traceparent header", async () => {
    const runId = await start({ traceparent: "not-a-traceparent" });
    const span = exported.find((candidate) => candidate.attributes["dee.run.id"] === runId);
    expect(span?.parentSpanContext).toBeUndefined();
    expect(await storedTraceparent(runId)).not.toBeNull();
  });

  it("emits no span for a start that an idempotency key answers with the existing run", async () => {
    const headers = { "idempotency-key": "once" };
    const first = await start(headers);
    const before = exported.length;
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ workflowType: "order", input: {} }),
    });
    await provider.forceFlush();
    expect(response.status).toBe(200);
    expect(exported.length).toBe(before);
    expect(
      exported.filter((candidate) => candidate.attributes["dee.run.id"] === first),
    ).toHaveLength(1);
  });
});
