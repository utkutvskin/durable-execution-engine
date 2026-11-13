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
});
