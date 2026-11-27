import { describe, expect, it } from "vitest";
import { ApiError, createApiClient, type StreamSlice } from "./api.js";

const none = { status: "", workflowType: "", from: "", to: "" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createApiClient", () => {
  it("sends the key as a bearer token and the filters as a query", async () => {
    const seen: { url: string; authorization: string | undefined }[] = [];
    const client = createApiClient("dee_key", (input, init) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ url: input as string, authorization: headers["authorization"] });
      return Promise.resolve(jsonResponse(200, { runs: [] }));
    });
    await client.listRuns({ ...none, status: "RUNNING" }, 25);
    expect(seen).toEqual([
      { url: "/v1/runs?status=RUNNING&limit=25", authorization: "Bearer dee_key" },
    ]);
  });

  it("raises an ApiError with the code of the error body", async () => {
    const client = createApiClient("k", () =>
      Promise.resolve(
        jsonResponse(404, { error: { code: "not_found", message: "run not found" } }),
      ),
    );
    const error = await client.describeRun("r").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe("not_found");
  });

  it("posts a signal with its payload and omits an unset payload", async () => {
    const bodies: unknown[] = [];
    const client = createApiClient("k", (_input, init) => {
      bodies.push(JSON.parse(init?.body as string));
      return Promise.resolve(jsonResponse(200, { sequenceNumber: 2 }));
    });
    await client.signalRun("r", "approve", { ok: true });
    await client.signalRun("r", "ping", undefined);
    expect(bodies).toEqual([{ name: "approve", payload: { ok: true } }, { name: "ping" }]);
  });

  it("posts an update with its argument and reads a query with a json argument", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const client = createApiClient("k", (input, init) => {
      const url = input as string;
      seen.push({
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(
        url.includes("/queries/")
          ? jsonResponse(200, { result: ["apple"] })
          : jsonResponse(200, { status: "completed", updateId: "u", sequenceNumber: 2, result: 1 }),
      );
    });
    const answer = await client.updateRun("r 1", "add", "apple");
    const result = await client.queryRun("r 1", "items", { all: true });
    expect(answer.result).toBe(1);
    expect(result).toEqual(["apple"]);
    expect(seen).toEqual([
      { url: "/v1/runs/r%201/updates/add", body: { argument: "apple" } },
      {
        url: `/v1/runs/r%201/queries/items?argument=${encodeURIComponent('{"all":true}')}`,
        body: undefined,
      },
    ]);
  });

  it("delivers stream slices and reports the last sequence and the end", async () => {
    const slice = (seq: number): string =>
      `id: ${String(seq)}\nevent: slice\ndata: ${JSON.stringify({
        events: [
          {
            sequenceNumber: seq,
            createdAt: "2026-03-01T10:00:00.000Z",
            event: { type: "run_started" },
          },
        ],
        status: "RUNNING",
        closed: false,
      })}\n\n`;
    const client = createApiClient("k", () =>
      Promise.resolve(new Response(`: open\n\n${slice(1)}${slice(2)}event: end\ndata: {}\n\n`)),
    );
    const slices: StreamSlice[] = [];
    const result = await client.streamRun(
      "r",
      0,
      (received) => slices.push(received),
      new AbortController().signal,
    );
    expect(slices.map((received) => received.events[0]?.sequenceNumber)).toEqual([1, 2]);
    expect(result).toEqual({ lastSequence: 2, ended: true });
  });

  it("follows the dead letter cursor until the last page", async () => {
    const urls: string[] = [];
    const letter = (id: string): Record<string, unknown> => ({ id });
    const client = createApiClient("k", (input) => {
      urls.push(input as string);
      return Promise.resolve(
        urls.length === 1
          ? jsonResponse(200, { deadLetters: [letter("a")], nextCursor: "a b" })
          : jsonResponse(200, { deadLetters: [letter("b")] }),
      );
    });
    const letters = await client.listDeadLetters();
    expect(letters.map((item) => item.id)).toEqual(["a", "b"]);
    expect(urls).toEqual(["/v1/dead-letters", "/v1/dead-letters?cursor=a%20b"]);
  });

  it("sends pauses, resumes, schedule toggles and backfills to their routes", async () => {
    const seen: { url: string; method: string | undefined; body: unknown }[] = [];
    const client = createApiClient("k", (input, init) => {
      seen.push({
        url: input as string,
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      });
      return Promise.resolve(jsonResponse(200, { triggers: [{ outcome: "STARTED" }] }));
    });
    await client.pause({ scope: "run", runId: "r 1" }, "");
    await client.pause({ scope: "queue" }, "deploy");
    await client.resume({ scope: "namespace" });
    await client.pauseSchedule("s/1");
    await client.resumeSchedule("s/1");
    const triggers = await client.backfillSchedule(
      "s/1",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
    );
    expect(triggers).toHaveLength(1);
    expect(seen).toEqual([
      { url: "/v1/pauses", method: "POST", body: { scope: "run", runId: "r 1" } },
      { url: "/v1/pauses", method: "POST", body: { scope: "queue", reason: "deploy" } },
      { url: "/v1/pauses/resume", method: "POST", body: { scope: "namespace" } },
      { url: "/v1/schedules/s%2F1/pause", method: "POST", body: {} },
      { url: "/v1/schedules/s%2F1/resume", method: "POST", body: {} },
      {
        url: "/v1/schedules/s%2F1/backfill",
        method: "POST",
        body: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
      },
    ]);
  });

  it("lists quarantined tasks and releases one by its encoded id, surfacing a 403", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    const client = createApiClient("k", (input, init) => {
      seen.push({ url: input as string, method: init?.method });
      if (seen.length === 1) {
        return Promise.resolve(jsonResponse(200, { tasks: [{ taskId: "t 1", runId: "r" }] }));
      }
      return Promise.resolve(
        seen.length === 2
          ? jsonResponse(200, { taskId: "t 1", runId: "r" })
          : jsonResponse(403, { error: { code: "forbidden", message: "needs operate" } }),
      );
    });
    expect((await client.listQuarantined()).map((task) => task.taskId)).toEqual(["t 1"]);
    await client.releaseQuarantined("t 1");
    await expect(client.releaseQuarantined("t 1")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "needs operate",
    });
    expect(seen).toEqual([
      { url: "/v1/quarantined-tasks", method: "GET" },
      { url: "/v1/quarantined-tasks/t%201/release", method: "POST" },
      { url: "/v1/quarantined-tasks/t%201/release", method: "POST" },
    ]);
  });

  it("posts resets, forks and batches to their endpoints and reads the reset points", async () => {
    const seen: { method: string; url: string; body: unknown }[] = [];
    const client = createApiClient("k", (input, init) => {
      const url = input as string;
      seen.push({
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/reset-points")) {
        return Promise.resolve(
          jsonResponse(200, { points: [{ sequence: 1, eventType: "run_started" }] }),
        );
      }
      if (url === "/v1/batches" && init?.method === "GET") {
        return Promise.resolve(jsonResponse(200, { batches: [] }));
      }
      return Promise.resolve(jsonResponse(201, { runId: "new", batchId: "b" }));
    });
    expect(await client.listResetPoints("r 1")).toEqual([
      { sequence: 1, eventType: "run_started" },
    ]);
    await client.resetRun("r", { kind: "event", sequence: 3 }, "why");
    await client.forkRun("r", { kind: "step", step: 2 }, "");
    await client.forkRun("r", { kind: "failed-step" }, "order-v2");
    await client.startBatch({ operation: "cancel", query: "status = 'RUNNING'" });
    expect(await client.listBatches()).toEqual([]);
    expect(seen).toEqual([
      { method: "GET", url: "/v1/runs/r%201/reset-points", body: undefined },
      {
        method: "POST",
        url: "/v1/runs/r/reset",
        body: { point: { kind: "event", sequence: 3 }, reason: "why" },
      },
      { method: "POST", url: "/v1/runs/r/fork", body: { point: { kind: "step", step: 2 } } },
      {
        method: "POST",
        url: "/v1/runs/r/fork",
        body: { point: { kind: "failed-step" }, workflowType: "order-v2" },
      },
      {
        method: "POST",
        url: "/v1/batches",
        body: { operation: "cancel", query: "status = 'RUNNING'" },
      },
      { method: "GET", url: "/v1/batches", body: undefined },
    ]);
  });
});
