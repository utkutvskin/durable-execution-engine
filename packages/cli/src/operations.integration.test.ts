import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "@dee/api";
import { createTaskQueue } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import type { CliIo } from "./io.ts";
import { main } from "./main.ts";

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

describe("wf pause, resume and schedule against a real api", () => {
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
    const issued = await api.apiKeys.issue("cli-operations");
    env = { WF_API_URL: `http://127.0.0.1:${String(port)}`, WF_API_KEY: issued.key };
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("pauses the queue, holds a started run's task, lists the pause and resumes it", async () => {
    expect(await wf("pause", "queue", "--reason", "deploy")).toMatchObject({
      code: 0,
      out: ["paused queue default"],
    });
    const started = await wf("run", "start", "order");
    const runId = started.out[0] ?? "";
    const queue = createTaskQueue(database.pool);
    expect(await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 })).toEqual([]);

    const listed = await wf("pause", "list", "--json");
    expect(JSON.parse(listed.out[0] ?? "{}")).toMatchObject({
      pauses: [{ scope: "queue", queueName: "default", reason: "deploy" }],
    });
    expect((await wf("pause", "queue")).out[0]).toMatch(/^already paused since /);
    expect(await wf("resume", "queue")).toMatchObject({ code: 0, out: ["resumed"] });
    expect(await wf("resume", "queue")).toMatchObject({ code: 0, out: ["it was not paused"] });
    const [task] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    expect(task?.runId).toBe(runId);
  });

  it("pauses one run and reports a closed or unknown run as an error", async () => {
    const runId = (await wf("run", "start", "order")).out[0] ?? "";
    expect(await wf("pause", "run", runId)).toMatchObject({
      code: 0,
      out: [`paused run ${runId}`],
    });
    expect((await wf("resume", "run", runId)).out).toEqual(["resumed"]);
    const unknown = await wf("pause", "run", "00000000-0000-4000-8000-000000000000");
    expect(unknown.code).toBe(1);
    expect(unknown.err[0]).toMatch(/run not found/);
  });

  it("creates, describes, pauses, backfills twice and resumes a schedule", async () => {
    const created = await wf(
      "schedule",
      "create",
      "hourly-report",
      "0 * * * *",
      "report",
      "--overlap",
      "cancel_other",
      "--input",
      '{"kind":"hourly"}',
      "--json",
    );
    expect(created.code).toBe(0);
    const schedule = JSON.parse(created.out[0] ?? "{}") as { scheduleId: string };
    expect(schedule).toMatchObject({ overlapPolicy: "cancel_other", input: { kind: "hourly" } });

    expect((await wf("schedule", "list")).out[0]).toContain("hourly-report");
    expect((await wf("schedule", "pause", schedule.scheduleId)).out[0]).toMatch(
      /^schedule hourly-report is PAUSED/,
    );
    const range = ["--from", "2026-02-27T00:00:00Z", "--to", "2026-02-28T00:00:00Z"];
    const first = await wf(
      "schedule",
      "backfill",
      schedule.scheduleId,
      ...range,
      "--overlap",
      "allow_all",
    );
    expect(first.out.at(-1)).toBe("24 triggers handled, 24 runs started");
    const second = await wf("schedule", "backfill", schedule.scheduleId, ...range);
    expect(second.out).toEqual(["0 triggers handled, 0 runs started"]);

    const described = await wf("schedule", "describe", schedule.scheduleId);
    expect(described.out).toContain("state      PAUSED");
    expect(described.out.filter((line) => line.includes("STARTED"))).toHaveLength(10);
    expect((await wf("schedule", "resume", schedule.scheduleId)).out[0]).toMatch(/is ACTIVE/);
  });

  it("refuses malformed schedule and pause arguments as usage errors", async () => {
    expect((await wf("pause", "everything")).code).toBe(2);
    expect((await wf("resume")).code).toBe(2);
    expect((await wf("schedule", "create", "x", "* * * * *", "t", "--overlap", "maybe")).code).toBe(
      2,
    );
    const noRange = await wf("schedule", "backfill", "00000000-0000-4000-8000-000000000000");
    expect(noRange.code).toBe(2);
    expect(noRange.err[0]).toMatch(/missing --from/);
    expect((await wf("schedule", "teleport")).code).toBe(2);
    const unknown = await wf("schedule", "describe", "00000000-0000-4000-8000-000000000000");
    expect(unknown).toMatchObject({ code: 1, err: ["error: schedule not found"] });
  });
});
