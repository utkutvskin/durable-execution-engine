import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTaskQueue, type TaskQueue } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { validateOpenApiDocument } from "./openapi-validator.ts";
import { createRunService } from "./run-service.ts";
import { createApiServer } from "./server.ts";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const QUEUE = "default";

describe("pauses and schedules over http", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let key: string;
  let otherKey: string;
  let queue: TaskQueue;
  let closeServer: () => Promise<void>;
  const clock = { now: () => new Date("2026-03-01T10:30:00.000Z") };

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    apiKey = key,
  ): Promise<Reply> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function start(): Promise<string> {
    const started = await call("POST", "/v1/runs", { workflowType: "order" });
    expect(started.status).toBe(201);
    return (started.body["run"] as { runId: string }).runId;
  }

  async function drain(): Promise<string[]> {
    const runIds: string[] = [];
    for (;;) {
      const batch = await queue.dequeue({
        queueName: QUEUE,
        visibilityTimeoutMs: 30_000,
        limit: 20,
      });
      if (batch.length === 0) {
        return runIds;
      }
      for (const task of batch) {
        runIds.push(task.runId);
        await queue.ack(task.id, task.leaseToken);
      }
    }
  }

  function errorCode(reply: Reply): string {
    return (reply.body["error"] as { code: string }).code;
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const api = createApiServer(database.pool, {
      queueName: QUEUE,
      service: createRunService(database.pool, { queueName: QUEUE, clock }),
    });
    expect(validateOpenApiDocument(api.openApiDocument)).toEqual([]);
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
    key = (await api.apiKeys.issue("operations")).key;
    otherKey = (await api.apiKeys.issue("elsewhere")).key;
    queue = createTaskQueue(database.pool);
  });

  beforeEach(async () => {
    await database.pool.query("delete from pauses");
    await drain();
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("a queue paused over http dequeues nothing and resumes with every task intact", async () => {
    const paused = await call("POST", "/v1/pauses", { scope: "queue", reason: "deploy" });
    expect(paused.status).toBe(201);
    expect(paused.body["pause"]).toMatchObject({
      scope: "queue",
      queueName: QUEUE,
      reason: "deploy",
    });
    const runIds = [await start(), await start(), await start()];
    expect(await drain()).toEqual([]);
    expect((await call("POST", "/v1/pauses", { scope: "queue" })).status).toBe(200);
    expect((await call("GET", "/v1/pauses")).body["pauses"]).toHaveLength(1);

    const resumed = await call("POST", "/v1/pauses/resume", { scope: "queue" });
    expect(resumed).toEqual({ status: 200, body: { resumed: true } });
    expect((await drain()).sort()).toEqual([...runIds].sort());
    expect((await call("POST", "/v1/pauses/resume", { scope: "queue" })).body).toEqual({
      resumed: false,
    });
  });

  it("a paused run shows its pause and holds back only its own tasks", async () => {
    const held = await start();
    const free = await start();
    expect((await call("POST", "/v1/pauses", { scope: "run", runId: held })).status).toBe(201);
    const described = await call("GET", `/v1/runs/${held}`);
    expect(described.body["paused"]).toMatchObject([{ scope: "run", runId: held }]);
    expect((await call("GET", `/v1/runs/${free}`)).body).not.toHaveProperty("paused");
    expect(await drain()).toEqual([free]);

    await call("POST", "/v1/pauses", { scope: "namespace" });
    const both = await call("GET", `/v1/runs/${held}`);
    expect((both.body["paused"] as { scope: string }[]).map((pause) => pause.scope)).toEqual([
      "run",
      "namespace",
    ]);
    await call("POST", "/v1/pauses/resume", { scope: "run", runId: held });
    expect(await drain()).toEqual([]);
    await call("POST", "/v1/pauses/resume", { scope: "namespace" });
    expect(await drain()).toEqual([held]);
  });

  it("refuses a run pause without a run id, for another namespace's run and for a closed run", async () => {
    const missing = await call("POST", "/v1/pauses", { scope: "run" });
    expect(missing.status).toBe(400);
    expect(errorCode(missing)).toBe("validation_failed");
    const runId = await start();
    const foreign = await call("POST", "/v1/pauses", { scope: "run", runId }, otherKey);
    expect(foreign.status).toBe(404);
    await call("POST", `/v1/runs/${runId}/terminate`, {});
    const closed = await call("POST", "/v1/pauses", { scope: "run", runId });
    expect(closed.status).toBe(409);
    expect(errorCode(closed)).toBe("run_closed");
    await drain();
  });

  it("creates, lists, pauses, resumes and backfills a schedule, and a repeated backfill starts nothing", async () => {
    const created = await call("POST", "/v1/schedules", {
      name: "hourly-report",
      cronExpression: "0 * * * *",
      workflowType: "report",
      input: { kind: "hourly" },
      overlapPolicy: "cancel_other",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "hourly-report",
      overlapPolicy: "cancel_other",
      state: "ACTIVE",
      queueName: QUEUE,
      nextFireAt: "2026-03-01T11:00:00.000Z",
    });
    const scheduleId = created.body["scheduleId"] as string;
    expect((await call("GET", "/v1/schedules")).body["schedules"]).toMatchObject([{ scheduleId }]);

    const paused = await call("POST", `/v1/schedules/${scheduleId}/pause`);
    expect(paused.body).toMatchObject({ state: "PAUSED" });
    const range = {
      from: "2026-02-28T00:00:00.000Z",
      to: "2026-03-01T00:00:00.000Z",
      overlapPolicy: "allow_all",
    };
    const first = await call("POST", `/v1/schedules/${scheduleId}/backfill`, range);
    expect(first.status).toBe(200);
    expect(first.body["triggers"]).toHaveLength(24);
    const again = await call("POST", `/v1/schedules/${scheduleId}/backfill`, range);
    expect(again.body).toEqual({ triggers: [] });
    const runs = await database.pool.query<{ count: string }>(
      "select count(*) from workflow_runs where schedule_id = $1",
      [scheduleId],
    );
    expect(Number(runs.rows[0]?.count)).toBe(24);
    const triggers = await call("GET", `/v1/schedules/${scheduleId}/triggers?limit=3`);
    expect(
      (triggers.body["triggers"] as { scheduledFor: string }[]).map((t) => t.scheduledFor),
    ).toEqual(["2026-02-28T23:00:00.000Z", "2026-02-28T22:00:00.000Z", "2026-02-28T21:00:00.000Z"]);

    const resumed = await call("POST", `/v1/schedules/${scheduleId}/resume`);
    expect(resumed.body).toMatchObject({ state: "ACTIVE", nextFireAt: "2026-03-01T11:00:00.000Z" });
    await drain();
  });

  it("answers schedule errors with stable codes and hides other namespaces' schedules", async () => {
    const body = { name: "dup", cronExpression: "*/5 * * * *", workflowType: "report" };
    expect((await call("POST", "/v1/schedules", body)).status).toBe(201);
    const duplicate = await call("POST", "/v1/schedules", body);
    expect([duplicate.status, errorCode(duplicate)]).toEqual([409, "schedule_exists"]);
    const invalid = await call("POST", "/v1/schedules", {
      ...body,
      name: "bad",
      cronExpression: "nope",
    });
    expect([invalid.status, errorCode(invalid)]).toEqual([400, "invalid_schedule"]);
    const policy = await call("POST", "/v1/schedules", {
      ...body,
      name: "p",
      overlapPolicy: "maybe",
    });
    expect(policy.status).toBe(400);

    const scheduleId = (await call("GET", "/v1/schedules")).body["schedules"] as {
      scheduleId: string;
      name: string;
    }[];
    const dup = scheduleId.find((schedule) => schedule.name === "dup")?.scheduleId ?? "";
    expect((await call("GET", `/v1/schedules/${dup}`, undefined, otherKey)).status).toBe(404);
    expect((await call("POST", `/v1/schedules/${dup}/pause`, undefined, otherKey)).status).toBe(
      404,
    );
    expect((await call("GET", "/v1/schedules/not-a-uuid")).status).toBe(404);
    expect((await call("GET", "/v1/schedules", undefined, otherKey)).body).toEqual({
      schedules: [],
    });

    const reversed = await call("POST", `/v1/schedules/${dup}/backfill`, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-02-28T00:00:00.000Z",
    });
    expect([reversed.status, errorCode(reversed)]).toEqual([400, "invalid_backfill"]);
    const tooWide = await call("POST", `/v1/schedules/${dup}/backfill`, {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
    expect([tooWide.status, errorCode(tooWide)]).toEqual([400, "invalid_backfill"]);
    const started = await database.pool.query<{ count: string }>(
      "select count(*) from workflow_runs where schedule_id = $1",
      [dup],
    );
    expect(Number(started.rows[0]?.count)).toBe(0);
  });
});
