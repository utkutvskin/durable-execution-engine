import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "@dee/api";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import type { CliIo } from "./io.ts";
import { main } from "./main.ts";
import { issueTestKey } from "../../api/src/test-keys.ts";

function captureIo(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env,
    cwd: "/nonexistent-wf-test-directory",
  };
  return { io, out, err };
}

describe("wf reset, fork and batch against a real api", () => {
  let database: IsolatedSchema;
  let env: Record<string, string>;
  let closeServer: () => Promise<void>;

  async function wf(...argv: string[]) {
    const captured = captureIo(env);
    const code = await main(argv, captured.io);
    return { code, out: captured.out, err: captured.err };
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const api = createApiServer(database.pool, { queueName: "default" });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    const { port } = api.server.address() as AddressInfo;
    closeServer = () =>
      new Promise<void>((resolve) => {
        api.server.close(() => {
          resolve();
        });
        api.server.closeAllConnections();
      });
    const issued = await issueTestKey(api.apiKeys, "cli-recovery");
    env = { WF_API_URL: `http://127.0.0.1:${String(port)}`, WF_API_KEY: issued.key };
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("resets an open run to its first event and forks it under another type", async () => {
    const runId = (await wf("run", "start", "order")).out[0] ?? "";
    const forked = await wf("fork", runId, "--event", "1", "--workflow-type", "order-v2", "--json");
    expect(forked.code).toBe(0);
    expect(JSON.parse(forked.out[0] ?? "{}")).toMatchObject({
      kind: "fork",
      workflowType: "order-v2",
      resetFromRunId: runId,
    });

    const reset = await wf("reset", runId, "--event", "1", "--reason", "bad deploy");
    expect(reset.code).toBe(0);
    expect(reset.out[0]).toMatch(
      new RegExp(`^reset ${runId} to new run [0-9a-f-]{36} \\(order, events 1-1 copied\\)$`),
    );
    expect(reset.out[1]).toBe(`terminated ${runId}`);
    expect((await wf("run", "describe", runId, "--json")).out[0]).toContain('"TERMINATED"');
  });

  it("explains a cut the history cannot take and refuses flags that name no single cut", async () => {
    const runId = (await wf("run", "start", "order")).out[0] ?? "";
    const failed = await wf("reset", runId, "--failed-step");
    expect(failed.code).not.toBe(0);
    expect(failed.err.join("\n")).toContain("no step of the run failed for good");
    expect((await wf("reset", runId)).code).toBe(2);
    expect((await wf("fork", runId, "--event", "1", "--step", "2")).code).toBe(2);
    expect((await wf("reset", runId, "--step", "zero")).code).toBe(2);
  });

  it("starts a terminate batch over a query, then lists and shows it with its targets", async () => {
    await wf("run", "start", "invoice");
    await wf("run", "start", "invoice");
    const started = await wf(
      "batch",
      "start",
      "terminate",
      "--query",
      "workflowType = 'invoice'",
      "--rate",
      "20",
      "--json",
    );
    expect(started.code).toBe(0);
    const batch = JSON.parse(started.out[0] ?? "{}") as { batchId: string; total: number };
    expect(batch).toMatchObject({ total: 2, pageSize: 20, pageIntervalMs: 1000 });

    const listed = await wf("batch", "list");
    expect(listed.out.some((line) => line.startsWith(batch.batchId))).toBe(true);
    const shown = await wf("batch", "show", batch.batchId, "--targets");
    expect(shown.out[0]).toContain("0 applied, 0 skipped, 2 left of 2");
    expect(shown.out.slice(1).every((line) => line.includes("PENDING"))).toBe(true);
    expect(shown.out).toHaveLength(3);
  });

  it("refuses a batch without a query, with an unknown operation or an event cut", async () => {
    expect((await wf("batch", "start", "terminate")).code).toBe(2);
    expect((await wf("batch", "start", "delete", "--query", "")).code).toBe(2);
    expect(
      (await wf("batch", "start", "reset", "--query", "", "--event", "3")).err.join("\n"),
    ).toContain("not --event");
    expect((await wf("batch")).code).toBe(2);
  });
});
