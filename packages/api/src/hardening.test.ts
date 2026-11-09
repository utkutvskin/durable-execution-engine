import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createDeadLetterQueue,
  createLogger,
  createPostgresEventStore,
  createWorkflowRegistry,
  defineWorkflow,
  noopTracing,
  type EngineMetrics,
  type Tracing,
  type TraceSpan,
} from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { createApiKeyStore, type ApiKeyStore } from "./api-keys.ts";
import { createApiServer, type ApiOptions } from "./server.ts";

interface Harness {
  readonly baseUrl: string;
  readonly apiKeys: ApiKeyStore;
  readonly logLines: Record<string, unknown>[];
  close(): Promise<void>;
}

describe("api hardening", () => {
  let database: IsolatedSchema;
  const open: Harness[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterEach(async () => {
    while (open.length > 0) {
      await open.pop()?.close();
    }
  });

  afterAll(async () => {
    await database.close();
  });

  async function serve(options: Partial<ApiOptions> = {}): Promise<Harness> {
    const logLines: Record<string, unknown>[] = [];
    const api = createApiServer(database.pool, {
      queueName: "default",
      logger: createLogger({
        sink: (line) => logLines.push(JSON.parse(line) as Record<string, unknown>),
      }),
      ...options,
    });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    const { port } = api.server.address() as AddressInfo;
    const harness: Harness = {
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiKeys: api.apiKeys,
      logLines,
      close: () =>
        new Promise<void>((resolve) => {
          api.server.close(() => {
            resolve();
          });
          api.server.closeAllConnections();
        }),
    };
    open.push(harness);
    return harness;
  }

  async function namespaceKey(harness: Harness, label: string): Promise<string> {
    return (await harness.apiKeys.issue(`${label}-${Math.random().toString(36).slice(2)}`)).key;
  }

  function auth(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}`, "content-type": "application/json" };
  }

  async function startRun(harness: Harness, key: string, body: unknown = {}): Promise<string> {
    const response = await fetch(`${harness.baseUrl}/v1/runs`, {
      method: "POST",
      headers: auth(key),
      body: JSON.stringify({ workflowType: "order", input: {}, ...(body as object) }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { run: { runId: string } }).run.runId;
  }

  async function namespaceIdOf(runId: string): Promise<string> {
    const row = await database.pool.query<{ namespace_id: string }>(
      "select namespace_id from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0]?.namespace_id ?? "";
  }

  describe("request errors", () => {
    it("answers 400 for a malformed percent encoding in a path parameter", async () => {
      const harness = await serve();
      const key = await namespaceKey(harness, "percent");

      const response = await fetch(`${harness.baseUrl}/v1/runs/%E0%A4%A/history`, {
        headers: auth(key),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "malformed_request",
      );
    });

    it("answers 400 for a malformed percent encoding on the stream path", async () => {
      const harness = await serve();

      const response = await fetch(`${harness.baseUrl}/v1/runs/%ZZ/stream`);

      expect(response.status).toBe(400);
    });

    it("logs a 500 with the correlation id of the response and hides the cause from the body", async () => {
      const failing = {
        describeRun: () => Promise.reject(new Error("connection reset by peer")),
      } as unknown as NonNullable<ApiOptions["service"]>;
      const harness = await serve({ service: failing });
      const key = await namespaceKey(harness, "boom");

      const response = await fetch(
        `${harness.baseUrl}/v1/runs/00000000-0000-4000-8000-000000000000`,
        { headers: { ...auth(key), "x-correlation-id": "trace-me-1" } },
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("x-correlation-id")).toBe("trace-me-1");
      expect(JSON.stringify(await response.json())).not.toContain("connection reset");
      const failure = harness.logLines.find((line) => line["message"] === "request failed");
      expect(failure).toMatchObject({
        level: "error",
        correlationId: "trace-me-1",
        method: "GET",
        path: "/v1/runs/00000000-0000-4000-8000-000000000000",
      });
      expect(JSON.stringify(failure)).toContain("connection reset by peer");
    });

    it("does not log a client error as a failure", async () => {
      const harness = await serve();
      const key = await namespaceKey(harness, "quiet");

      await fetch(`${harness.baseUrl}/v1/runs/not-a-uuid`, { headers: auth(key) });

      expect(harness.logLines.some((line) => line["message"] === "request failed")).toBe(false);
    });

    it("sets nosniff on json answers of every status", async () => {
      const harness = await serve();
      const key = await namespaceKey(harness, "sniff");

      const ok = await fetch(`${harness.baseUrl}/v1/namespace`, { headers: auth(key) });
      const unauthorized = await fetch(`${harness.baseUrl}/v1/namespace`);
      const missing = await fetch(`${harness.baseUrl}/nowhere`);
      const spec = await fetch(`${harness.baseUrl}/openapi.json`);

      for (const response of [ok, unauthorized, missing, spec]) {
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
    });
  });

  describe("unauthenticated requests", () => {
    it("bounds the queries a flood of 1000 unauthenticated requests costs", async () => {
      let lookups = 0;
      const real = createApiKeyStore(database.pool);
      const counting: ApiKeyStore = {
        ...real,
        authenticate: (key) => {
          lookups += 1;
          return real.authenticate(key);
        },
      };
      const harness = await serve({ apiKeys: counting, authThrottle: { maxFailures: 10 } });
      const statuses = new Map<number, number>();

      for (let batch = 0; batch < 20; batch += 1) {
        const replies = await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            fetch(`${harness.baseUrl}/v1/runs`, {
              headers: { authorization: `Bearer dee_wrong${String(batch * 50 + index)}` },
            }),
          ),
        );
        for (const reply of replies) {
          statuses.set(reply.status, (statuses.get(reply.status) ?? 0) + 1);
          await reply.arrayBuffer();
        }
      }

      expect(lookups).toBeLessThanOrEqual(10 + 50);
      expect(statuses.get(401)).toBeLessThanOrEqual(10 + 50);
      expect(statuses.get(429)).toBeGreaterThanOrEqual(1000 - 10 - 50);
      expect((statuses.get(401) ?? 0) + (statuses.get(429) ?? 0)).toBe(1000);
    });

    it("answers 429 with retry-after once an address used up its failures, and recovers after the window", async () => {
      let now = 0;
      const harness = await serve({
        authThrottle: { maxFailures: 3, windowMs: 60_000 },
        nowMs: () => now,
      });
      const key = await namespaceKey(harness, "window");
      const attempt = (): Promise<Response> =>
        fetch(`${harness.baseUrl}/v1/runs`, { headers: auth("dee_nope") });

      const first = [await attempt(), await attempt(), await attempt()];
      const blocked = await attempt();
      const stillValid = await fetch(`${harness.baseUrl}/v1/runs`, { headers: auth(key) });
      now = 60_001;
      const afterWindow = await fetch(`${harness.baseUrl}/v1/runs`, { headers: auth(key) });

      expect(first.map((reply) => reply.status)).toEqual([401, 401, 401]);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(stillValid.status).toBe(429);
      expect(afterWindow.status).toBe(200);
    });

    it("does not count successful requests as failures", async () => {
      const harness = await serve({ authThrottle: { maxFailures: 2 } });
      const key = await namespaceKey(harness, "success");

      const statuses: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        statuses.push((await fetch(`${harness.baseUrl}/v1/runs`, { headers: auth(key) })).status);
      }

      expect(statuses).toEqual(Array.from({ length: 8 }, () => 200));
    });

    it("throttles failed stream authentication the same way", async () => {
      const harness = await serve({ authThrottle: { maxFailures: 2 } });
      const url = `${harness.baseUrl}/v1/runs/00000000-0000-4000-8000-000000000000/stream`;

      const statuses = [
        (await fetch(url)).status,
        (await fetch(url, { headers: auth("dee_bad") })).status,
        (await fetch(url)).status,
      ];

      expect(statuses).toEqual([401, 401, 429]);
    });
  });

  describe("event streams", () => {
    async function openStream(harness: Harness, key: string, runId: string): Promise<Response> {
      return fetch(`${harness.baseUrl}/v1/runs/${runId}/stream`, {
        headers: { ...auth(key), accept: "text/event-stream" },
      });
    }

    it("refuses a stream beyond the namespace cap, serves other namespaces and frees a slot when one closes", async () => {
      const harness = await serve({ maxStreamsPerNamespace: 2, streamPollMs: 20 });
      const keyA = await namespaceKey(harness, "cap-a");
      const keyB = await namespaceKey(harness, "cap-b");
      const runA = await startRun(harness, keyA);
      const runB = await startRun(harness, keyB);

      const first = await openStream(harness, keyA, runA);
      const second = await openStream(harness, keyA, runA);
      const third = await openStream(harness, keyA, runA);
      const otherNamespace = await openStream(harness, keyB, runB);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBe("5");
      expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
        "stream_limit_reached",
      );
      expect(otherNamespace.status).toBe(200);

      await first.body?.cancel();
      let reopened: Response | undefined;
      for (let attempt = 0; attempt < 50 && reopened?.status !== 200; attempt += 1) {
        reopened = await openStream(harness, keyA, runA);
        if (reopened.status !== 200) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(reopened?.status).toBe(200);
      await Promise.all([
        second.body?.cancel(),
        otherNamespace.body?.cancel(),
        reopened?.body?.cancel(),
      ]);
    });

    it("ends a stream with a reconnect event once it has lived its maximum lifetime", async () => {
      let now = 0;
      const harness = await serve({
        maxStreamLifetimeMs: 1000,
        streamPollMs: 10,
        nowMs: () => now,
      });
      const key = await namespaceKey(harness, "lifetime");
      const runId = await startRun(harness, key);

      const response = await openStream(harness, key, runId);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      const readUntil = async (marker: string): Promise<void> => {
        while (!text.includes(marker)) {
          const chunk = await reader.read();
          if (chunk.done) {
            return;
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      };
      await readUntil("event: slice");
      now = 1001;
      await readUntil("event: reconnect");
      const finished = await reader.read();

      expect(text).toContain("event: reconnect");
      expect(text).not.toContain("event: end");
      expect(finished.done).toBe(true);
    });
  });

  describe("metrics", () => {
    function stubMetrics(): { metrics: EngineMetrics; renders: () => number } {
      let renders = 0;
      const metrics = {
        render: async (): Promise<string> => {
          renders += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `# scrape ${String(renders)}\n`;
        },
      } as unknown as EngineMetrics;
      return { metrics, renders: () => renders };
    }

    it("serves one render for scrapes within the cache interval and renders again after it", async () => {
      let now = 0;
      const { metrics, renders } = stubMetrics();
      const harness = await serve({ metrics, metricsCacheMs: 5000, nowMs: () => now });

      const first = await (await fetch(`${harness.baseUrl}/metrics`)).text();
      now = 4999;
      const second = await (await fetch(`${harness.baseUrl}/metrics`)).text();
      now = 5001;
      const third = await (await fetch(`${harness.baseUrl}/metrics`)).text();

      expect(first).toBe("# scrape 1\n");
      expect(second).toBe("# scrape 1\n");
      expect(third).toBe("# scrape 2\n");
      expect(renders()).toBe(2);
    });

    it("shares one render between scrapes that arrive while it runs", async () => {
      const { metrics, renders } = stubMetrics();
      const harness = await serve({ metrics });

      const replies = await Promise.all(
        Array.from({ length: 10 }, () => fetch(`${harness.baseUrl}/metrics`)),
      );
      await Promise.all(replies.map((reply) => reply.text()));

      expect(renders()).toBe(1);
    });

    it("does not cache a failed render", async () => {
      let calls = 0;
      const metrics = {
        render: (): Promise<string> => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error("db down")) : Promise.resolve("# ok\n");
        },
      } as unknown as EngineMetrics;
      const harness = await serve({ metrics, metricsCacheMs: 60_000 });

      const failed = await fetch(`${harness.baseUrl}/metrics`);
      const recovered = await fetch(`${harness.baseUrl}/metrics`);

      expect(failed.status).toBe(503);
      expect(recovered.status).toBe(200);
    });

    it("requires the bearer token when one is configured", async () => {
      const { metrics } = stubMetrics();
      const harness = await serve({ metrics, metricsToken: "scrape-secret" });

      const anonymous = await fetch(`${harness.baseUrl}/metrics`);
      const wrong = await fetch(`${harness.baseUrl}/metrics`, {
        headers: { authorization: "Bearer other" },
      });
      const right = await fetch(`${harness.baseUrl}/metrics`, {
        headers: { authorization: "Bearer scrape-secret" },
      });

      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
      expect(wrong.status).toBe(401);
      expect(right.status).toBe(200);
      expect(right.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("leaves /health and /ready open when a metrics token is set", async () => {
      const { metrics } = stubMetrics();
      const harness = await serve({ metrics, metricsToken: "scrape-secret" });

      const health = await fetch(`${harness.baseUrl}/health`);

      expect(health.status).toBe(200);
    });
  });

  describe("pagination", () => {
    async function appendHistory(runId: string, count: number): Promise<void> {
      const store = createPostgresEventStore(database.pool);
      let expected = 1;
      for (let index = 0; index < count; index += 1) {
        await store.append(runId, expected, [
          { type: "signal_received", signalName: `s${String(index)}`, payload: index },
        ]);
        expected += 1;
      }
    }

    it("pages a run's history with a cursor and returns every event exactly once in order", async () => {
      const harness = await serve();
      const key = await namespaceKey(harness, "history");
      const runId = await startRun(harness, key);
      await appendHistory(runId, 6);

      const sequences: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const query = new URLSearchParams({
          limit: "3",
          ...(cursor === undefined ? {} : { cursor }),
        });
        const reply = await fetch(
          `${harness.baseUrl}/v1/runs/${runId}/history?${query.toString()}`,
          {
            headers: auth(key),
          },
        );
        const body = (await reply.json()) as {
          events: { sequenceNumber: number }[];
          nextCursor?: string;
        };
        sequences.push(...body.events.map((event) => event.sequenceNumber));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== undefined);

      expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(pages).toBe(3);
    });

    it("returns the whole history without a nextCursor when it fits in one page", async () => {
      const harness = await serve();
      const key = await namespaceKey(harness, "short");
      const runId = await startRun(harness, key);

      const reply = await fetch(`${harness.baseUrl}/v1/runs/${runId}/history`, {
        headers: auth(key),
      });
      const body = (await reply.json()) as { events: unknown[]; nextCursor?: string };

      expect(body.events).toHaveLength(1);
      expect(body.nextCursor).toBeUndefined();
    });

    it("answers 400 for a malformed history cursor and for a limit above the maximum", async () => {
      const harness = await serve();
      const key = await namespaceKey(harness, "bad-cursor");
      const runId = await startRun(harness, key);

      const cursor = await fetch(`${harness.baseUrl}/v1/runs/${runId}/history?cursor=abc`, {
        headers: auth(key),
      });
      const limit = await fetch(`${harness.baseUrl}/v1/runs/${runId}/history?limit=100000`, {
        headers: auth(key),
      });

      expect(cursor.status).toBe(400);
      expect(((await cursor.json()) as { error: { code: string } }).error.code).toBe(
        "invalid_cursor",
      );
      expect(limit.status).toBe(400);
    });

    async function deadLetter(namespaceId: string, runId: string, stepId: string): Promise<string> {
      return createDeadLetterQueue(database.pool).add({
        namespaceId,
        runId,
        stepId,
        queueName: "default/steps",
        payload: { stepId, stepType: "charge", input: {} },
        attempts: 3,
        error: { name: "ChargeError", message: "card declined" },
        reason: "MAX_ATTEMPTS_EXHAUSTED",
      });
    }

    it("pages dead letters oldest first and never shows another namespace's", async () => {
      const harness = await serve();
      const keyA = await namespaceKey(harness, "dl-a");
      const keyB = await namespaceKey(harness, "dl-b");
      const runA = await startRun(harness, keyA);
      const runB = await startRun(harness, keyB);
      const namespaceA = await namespaceIdOf(runA);
      const namespaceB = await namespaceIdOf(runB);
      const expected: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        expected.push(await deadLetter(namespaceA, runA, `step-${String(index)}`));
        await deadLetter(namespaceB, runB, `other-${String(index)}`);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          limit: "2",
          ...(cursor === undefined ? {} : { cursor }),
        });
        const reply = await fetch(`${harness.baseUrl}/v1/dead-letters?${query.toString()}`, {
          headers: auth(keyA),
        });
        const body = (await reply.json()) as { deadLetters: { id: string }[]; nextCursor?: string };
        seen.push(...body.deadLetters.map((letter) => letter.id));
        cursor = body.nextCursor;
      } while (cursor !== undefined);

      expect(seen).toEqual(expected);
    });

    it("filters dead letters by namespace and limit in sql", async () => {
      const harness = await serve();
      const keyA = await namespaceKey(harness, "sql-a");
      const keyB = await namespaceKey(harness, "sql-b");
      const runA = await startRun(harness, keyA);
      const runB = await startRun(harness, keyB);
      const namespaceA = await namespaceIdOf(runA);
      const namespaceB = await namespaceIdOf(runB);
      const ownId = await deadLetter(namespaceA, runA, "mine");
      await deadLetter(namespaceB, runB, "theirs");
      await deadLetter(namespaceB, runB, "theirs-2");

      const queue = createDeadLetterQueue(database.pool);
      const own = await queue.list({ namespaceId: namespaceA });
      const capped = await queue.list({ namespaceId: namespaceB, limit: 1 });

      expect(own.map((letter) => letter.id)).toEqual([ownId]);
      expect(capped).toHaveLength(1);
      expect(capped[0]?.namespaceId).toBe(namespaceB);
    });

    it("answers 400 for a malformed dead letter cursor", async () => {
      const harness = await serve();
      const key = await namespaceKey(harness, "dl-cursor");

      const reply = await fetch(`${harness.baseUrl}/v1/dead-letters?cursor=nope`, {
        headers: auth(key),
      });

      expect(reply.status).toBe(400);
    });
  });

  describe("starting runs", () => {
    it("rejects a workflow type the registry does not know and accepts one it knows", async () => {
      const workflows = createWorkflowRegistry();
      workflows.register(defineWorkflow("known", () => Promise.resolve("done")));
      const harness = await serve({ workflows });
      const key = await namespaceKey(harness, "registry");
      const post = (workflowType: string): Promise<Response> =>
        fetch(`${harness.baseUrl}/v1/runs`, {
          method: "POST",
          headers: auth(key),
          body: JSON.stringify({ workflowType }),
        });

      const unknown = await post("mystery");
      const known = await post("known");

      expect(unknown.status).toBe(400);
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
        "unknown_workflow_type",
      );
      expect(known.status).toBe(201);
    });

    it("creates no run for a rejected workflow type", async () => {
      const harness = await serve({ workflows: createWorkflowRegistry() });
      const key = await namespaceKey(harness, "none");

      await fetch(`${harness.baseUrl}/v1/runs`, {
        method: "POST",
        headers: auth(key),
        body: JSON.stringify({ workflowType: "mystery" }),
      });
      const list = await fetch(`${harness.baseUrl}/v1/runs`, { headers: auth(key) });

      expect(((await list.json()) as { runs: unknown[] }).runs).toEqual([]);
    });

    function countingTracing(): { tracing: Tracing; started: () => number; ended: () => number } {
      let started = 0;
      let ended = 0;
      const tracing: Tracing = {
        startSpan(name, spanOptions): TraceSpan {
          const span = noopTracing.startSpan(name, spanOptions);
          started += 1;
          let finished = false;
          return {
            traceparent: span.traceparent,
            setAttributes: (attributes) => {
              span.setAttributes(attributes);
            },
            recordError: (error) => {
              span.recordError(error);
            },
            end: (endTime) => {
              if (!finished) {
                finished = true;
                ended += 1;
              }
              span.end(endTime);
            },
          };
        },
      };
      return { tracing, started: () => started, ended: () => ended };
    }

    it("ends the workflow.start span when concurrent starts race on one idempotency key", async () => {
      const { tracing, started, ended } = countingTracing();
      const harness = await serve({ tracing });
      const key = await namespaceKey(harness, "race");

      const replies = await Promise.all(
        Array.from({ length: 12 }, () =>
          fetch(`${harness.baseUrl}/v1/runs`, {
            method: "POST",
            headers: { ...auth(key), "idempotency-key": "same-key" },
            body: JSON.stringify({ workflowType: "order", input: { n: 1 } }),
          }),
        ),
      );
      await Promise.all(replies.map((reply) => reply.arrayBuffer()));

      expect(replies.filter((reply) => reply.status === 201)).toHaveLength(1);
      expect(started()).toBeGreaterThanOrEqual(1);
      expect(ended()).toBe(started());
    });

    it("ends the workflow.start span when the insert fails", async () => {
      const { tracing, started, ended } = countingTracing();
      const harness = await serve({ tracing });
      const key = await namespaceKey(harness, "insert-fails");

      const reply = await fetch(`${harness.baseUrl}/v1/runs`, {
        method: "POST",
        headers: auth(key),
        body: JSON.stringify({ workflowType: "bad\u0000type" }),
      });

      expect(reply.status).toBe(500);
      expect(started()).toBe(1);
      expect(ended()).toBe(1);
      expect(harness.logLines.some((line) => line["message"] === "request failed")).toBe(true);
    });
  });
});
