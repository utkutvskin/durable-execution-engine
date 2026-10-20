import { describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import type { CliIo } from "./io.js";
import { HELP_TEXT, main } from "./main.js";
import type { RunClient, RunSnapshot } from "./run-client.js";

function captureIo(env: Record<string, string | undefined> = {}): {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      env,
      cwd: "/nonexistent-wf-test-directory",
    },
  };
}

const snapshot: RunSnapshot = {
  runId: "11111111-1111-4111-8111-111111111111",
  workflowType: "demo",
  status: "COMPLETED",
  startedAt: "2026-01-01T00:00:00.000Z",
  closedAt: "2026-01-01T00:00:01.000Z",
  input: { n: 1 },
  result: { ok: true },
  error: null,
};

function fakeClient(calls: string[]): RunClient {
  return {
    start: (type, input, key) => {
      calls.push(`start ${type} ${JSON.stringify(input)} ${String(key)}`);
      return Promise.resolve(snapshot.runId);
    },
    signal: (runId, name, payload) => {
      calls.push(`signal ${runId} ${name} ${JSON.stringify(payload)}`);
      return Promise.resolve();
    },
    cancel: (runId, reason) => {
      calls.push(`cancel ${runId} ${String(reason)}`);
      return Promise.resolve();
    },
    describe: () => Promise.resolve(snapshot),
    history: () =>
      Promise.resolve([
        { sequenceNumber: 1, createdAt: snapshot.startedAt, event: { type: "run_started" } },
        { sequenceNumber: 2, createdAt: snapshot.startedAt, event: { type: "run_completed" } },
      ]),
    listRuns: (filter) => {
      calls.push(`list ${JSON.stringify(filter)}`);
      return Promise.resolve({ runs: [snapshot], nextCursor: "next-page" });
    },
    waitForClose: () => Promise.resolve(snapshot),
  };
}

describe("wf command line", () => {
  it("prints the help text and exits 0 for help, 2 for no command", async () => {
    const helped = captureIo();
    expect(await main(["help"], helped.io)).toBe(0);
    expect(helped.out.join("\n")).toBe(HELP_TEXT);
    const bare = captureIo();
    expect(await main([], bare.io)).toBe(2);
  });

  it("rejects an unknown command with exit code 2", async () => {
    const { io, err } = captureIo();
    expect(await main(["frobnicate"], io)).toBe(2);
    expect(err.join("\n")).toContain('unknown command "frobnicate"');
  });

  it("starts a run with json input and an idempotency key and prints its id", async () => {
    const calls: string[] = [];
    const { io, out } = captureIo();
    const code = await main(
      ["run", "start", "demo", "--input", '{"n":1}', "--idempotency-key", "k1"],
      io,
      { client: fakeClient(calls) },
    );
    expect(code).toBe(0);
    expect(out).toEqual([snapshot.runId]);
    expect(calls).toEqual(['start demo {"n":1} k1']);
  });

  it("waits for the run to close with --wait and maps the status to the exit code", async () => {
    const { io, out } = captureIo();
    expect(await main(["run", "start", "demo", "--wait"], io, { client: fakeClient([]) })).toBe(0);
    expect(out.join("\n")).toContain("status     COMPLETED");
    const failing: RunClient = {
      ...fakeClient([]),
      waitForClose: () => Promise.resolve({ ...snapshot, status: "FAILED" }),
    };
    expect(
      await main(["run", "start", "demo", "--wait"], captureIo().io, { client: failing }),
    ).toBe(1);
  });

  it("signals a run with a json payload and cancels it with a reason", async () => {
    const calls: string[] = [];
    const hooks = { client: fakeClient(calls) };
    expect(
      await main(
        ["run", "signal", snapshot.runId, "approval", "--payload", '{"approved":true}'],
        captureIo().io,
        hooks,
      ),
    ).toBe(0);
    expect(
      await main(
        ["run", "cancel", snapshot.runId, "--reason", "changed mind"],
        captureIo().io,
        hooks,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      `signal ${snapshot.runId} approval {"approved":true}`,
      `cancel ${snapshot.runId} changed mind`,
    ]);
  });

  it("describes a run with its history and lists runs with a paging hint", async () => {
    const described = captureIo();
    await main(["run", "describe", snapshot.runId, "--history"], described.io, {
      client: fakeClient([]),
    });
    expect(described.out.join("\n")).toContain('result     {"ok":true}');
    expect(described.out.join("\n")).toContain("2    run_completed");
    const calls: string[] = [];
    const listed = captureIo();
    await main(
      ["run", "list", "--status", "RUNNING", "--type", "demo", "--limit", "5"],
      listed.io,
      {
        client: fakeClient(calls),
      },
    );
    expect(calls).toEqual(['list {"status":"RUNNING","workflowType":"demo","limit":5}']);
    expect(listed.out.at(-1)).toBe("more runs follow, pass --cursor next-page");
  });

  it("prints machine readable output with --json", async () => {
    const { io, out } = captureIo();
    await main(["run", "describe", snapshot.runId, "--json"], io, { client: fakeClient([]) });
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ runId: snapshot.runId, status: "COMPLETED" });
  });

  it("explains what is missing instead of failing with a stack", async () => {
    const noKey = captureIo();
    expect(await main(["run", "list"], noKey.io)).toBe(1);
    expect(noKey.err.join("\n")).toContain("error: no api key");
    const noAction = captureIo();
    expect(await main(["run"], noAction.io, { client: fakeClient([]) })).toBe(2);
    const badJson = captureIo();
    expect(
      await main(["run", "start", "demo", "--input", "{"], badJson.io, { client: fakeClient([]) }),
    ).toBe(2);
    const badFlag = captureIo();
    expect(await main(["run", "list", "--nope"], badFlag.io, { client: fakeClient([]) })).toBe(2);
  });

  it("reports an api error by its message and exits 1", async () => {
    const failing: RunClient = {
      ...fakeClient([]),
      describe: () => Promise.reject(new ApiError(404, "not_found", "run not found")),
    };
    const { io, err } = captureIo();
    expect(await main(["run", "describe", snapshot.runId], io, { client: failing })).toBe(1);
    expect(err).toEqual(["error: run not found"]);
  });
});
