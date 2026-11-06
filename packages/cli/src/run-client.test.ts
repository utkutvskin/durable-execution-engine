import { describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import type { CliIo } from "./io.js";
import { main } from "./main.js";
import { createApiClient } from "./run-client.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function run(status: string): Record<string, unknown> {
  return {
    runId: RUN_ID,
    workflowType: "demo",
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  };
}

interface FakeTime {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly slept: number[];
}

function fakeTime(): FakeTime {
  let current = 0;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: (ms) => {
      slept.push(ms);
      current += ms;
      return Promise.resolve();
    },
    slept,
  };
}

function clientOver(
  answer: (url: string, init: RequestInit | undefined) => Response,
  time: FakeTime = fakeTime(),
): { client: ReturnType<typeof createApiClient>; urls: string[] } {
  const urls: string[] = [];
  const client = createApiClient({
    baseUrl: "http://api.test",
    apiKey: "dee_key",
    now: time.now,
    sleep: time.sleep,
    fetch: (input, init) => {
      urls.push(String(input));
      return Promise.resolve(answer(String(input), init));
    },
  });
  return { client, urls };
}

describe("api run client", () => {
  it("encodes a run id in every url it builds", async () => {
    const hostile = "a/b?c=d#e f";
    const { client, urls } = clientOver((url) =>
      url.endsWith("/history") ? json(200, { events: [] }) : json(200, run("RUNNING")),
    );

    await client.describe(hostile);
    await client.signal(hostile, "go");
    await client.cancel(hostile);
    await client.history(hostile);

    const encoded = encodeURIComponent(hostile);
    expect(urls).toEqual([
      `http://api.test/v1/runs/${encoded}`,
      `http://api.test/v1/runs/${encoded}/signal`,
      `http://api.test/v1/runs/${encoded}/cancel`,
      `http://api.test/v1/runs/${encoded}/history`,
    ]);
  });

  it("turns an html error page into an api error with the status and a short preview", async () => {
    const { client } = clientOver(
      () =>
        new Response("<html><body>\n  <h1>502 Bad Gateway</h1>\n</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );

    const error = await client.describe(RUN_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe("invalid_response");
    expect((error as ApiError).message).toContain("502 without a json error body");
    expect((error as ApiError).message).toContain("502 Bad Gateway");
  });

  it("turns a 200 answer that is not json into an api error", async () => {
    const { client } = clientOver(() => new Response("welcome", { status: 200 }));

    const error = await client.describe(RUN_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain("not json");
  });

  it("reports a non-json failure on stderr as one line without a stack trace", async () => {
    const err: string[] = [];
    const io: CliIo = {
      stdout: () => undefined,
      stderr: (line) => err.push(line),
      env: {},
      cwd: "/nonexistent-wf-test-directory",
    };
    const { client } = clientOver(() => new Response("upstream down", { status: 503 }));

    const code = await main(["run", "describe", RUN_ID], io, { client });

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("error: the api answered 503");
    expect(err[0]).not.toContain("\n    at ");
  });

  it("carries the retry-after of an error answer", async () => {
    const { client } = clientOver(() =>
      json(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "7" }),
    );

    const error = await client.describe(RUN_ID).catch((caught: unknown) => caught);

    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).retryAfterMs).toBe(7000);
  });

  it("waits out a 429 for the retry-after the api gave and then returns the closed run", async () => {
    const time = fakeTime();
    const answers = [
      json(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "3" }),
      json(200, run("RUNNING")),
      json(200, run("COMPLETED")),
    ];
    const { client } = clientOver(() => answers.shift() ?? json(200, run("COMPLETED")), time);

    const closed = await client.waitForClose(RUN_ID, { pollMs: 50, timeoutMs: 60_000 });

    expect(closed.status).toBe("COMPLETED");
    expect(time.slept).toEqual([3000, 50]);
  });

  it("does not sleep past the wait timeout when the api asks for a longer wait", async () => {
    const time = fakeTime();
    const { client } = clientOver(
      () =>
        json(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "600" }),
      time,
    );

    await expect(client.waitForClose(RUN_ID, { pollMs: 50, timeoutMs: 5000 })).rejects.toThrow(
      /after the wait timeout/,
    );
    expect(time.slept).toEqual([5000]);
  });

  it("still fails a wait on an error other than 429", async () => {
    const { client } = clientOver(() =>
      json(404, { error: { code: "not_found", message: "run not found" } }),
    );

    await expect(client.waitForClose(RUN_ID)).rejects.toMatchObject({ status: 404 });
  });

  it("reads a long history page by page", async () => {
    const pages = [
      json(200, {
        events: [{ sequenceNumber: 1, createdAt: "t", event: { type: "run_started" } }],
        nextCursor: "1",
      }),
      json(200, { events: [{ sequenceNumber: 2, createdAt: "t", event: { type: "x" } }] }),
    ];
    const { client, urls } = clientOver(() => pages.shift() ?? json(200, { events: [] }));

    const events = await client.history(RUN_ID);

    expect(events.map((event) => event.sequenceNumber)).toEqual([1, 2]);
    expect(urls[1]).toBe(`http://api.test/v1/runs/${RUN_ID}/history?cursor=1`);
  });
});

describe("wf run list --limit", () => {
  function captured(): { io: CliIo; err: string[] } {
    const err: string[] = [];
    return {
      err,
      io: {
        stdout: () => undefined,
        stderr: (line) => err.push(line),
        env: {},
        cwd: "/nonexistent-wf-test-directory",
      },
    };
  }

  it.each(["0", "-3", "abc", "1.5", "201", "99999999999999999999", ""])(
    "rejects --limit %j with a usage error before calling the api",
    async (limit) => {
      const { io, err } = captured();
      const { client, urls } = clientOver(() => json(200, { runs: [] }));

      const code = await main(["run", "list", `--limit=${limit}`], io, { client });

      expect(code).toBe(2);
      expect(err.join("\n")).toContain("--limit must be a whole number from 1 to 200");
      expect(urls).toEqual([]);
    },
  );

  it.each(["1", "50", "200"])("passes --limit %s to the api", async (limit) => {
    const { io } = captured();
    const { client, urls } = clientOver(() => json(200, { runs: [] }));

    const code = await main(["run", "list", `--limit=${limit}`], io, { client });

    expect(code).toBe(0);
    expect(urls).toEqual([`http://api.test/v1/runs?limit=${limit}`]);
  });
});
