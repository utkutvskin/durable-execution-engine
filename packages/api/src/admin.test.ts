import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeadLetterQueue } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { createApiKeyStore, type ApiKeyStore } from "./api-keys.ts";
import { validateOpenApiDocument } from "./openapi-validator.ts";
import { createApiServer, type ApiHandler } from "./server.ts";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface AuditEntryBody {
  readonly action: string;
  readonly namespace: string | null;
  readonly target: string | null;
  readonly details: Record<string, unknown>;
  readonly actor: { keyId: string; label: string; namespace: string; scope: string };
}

const QUEUE = "default";
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

describe("admin surface and key scopes", () => {
  let database: IsolatedSchema;
  let api: ApiHandler;
  let keys: ApiKeyStore;
  let baseUrl: string;
  let adminKey: string;
  let adminKeyId: string;
  let operateKey: string;
  let operateKeyId: string;
  let readKey: string;
  let closeServer: () => Promise<void>;
  let now = new Date("2030-05-01T12:00:00.000Z");

  async function call(
    apiKey: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
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

  function errorCode(reply: Reply): string {
    return (reply.body["error"] as { code: string }).code;
  }

  async function startRun(): Promise<string> {
    const started = await call(operateKey, "POST", "/v1/runs", { workflowType: "order" });
    expect(started.status).toBe(201);
    return (started.body["run"] as { runId: string }).runId;
  }

  async function namespaceIdOf(name: string): Promise<string> {
    return keys.namespaceId(name);
  }

  async function quarantine(runId: string, taskType = "STEP_TASK"): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, state, quarantined_at,
                          quarantine_reason, reclaim_count)
       values ($1, $2, $3, $4, 'QUARANTINED', now(), 'lease lost 10 times', 10) returning id`,
      [await namespaceIdOf("ops"), runId, `${QUEUE}/steps`, taskType],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error("no task inserted");
    }
    return id;
  }

  async function auditEntries(namespace?: string): Promise<AuditEntryBody[]> {
    const query = namespace === undefined ? "" : `?namespace=${encodeURIComponent(namespace)}`;
    const reply = await call(adminKey, "GET", `/v1/admin/audit-log${query}`);
    expect(reply.status).toBe(200);
    return reply.body["entries"] as AuditEntryBody[];
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    keys = createApiKeyStore(database.pool, { clock: { now: () => now } });
    const server = createApiServer(database.pool, { queueName: QUEUE, apiKeys: keys });
    api = server;
    expect(validateOpenApiDocument(server.openApiDocument)).toEqual([]);
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${String((server.server.address() as AddressInfo).port)}`;
    closeServer = () =>
      new Promise<void>((resolve) => {
        server.server.close(() => {
          resolve();
        });
        server.server.closeAllConnections();
      });
    await keys.ensureNamespace("ops");
    const admin = await keys.issue("ops", { scope: "admin", label: "ops-admin" });
    const operate = await keys.issue("ops", { scope: "operate", label: "ops-operator" });
    adminKey = admin.key;
    adminKeyId = admin.keyId;
    operateKey = operate.key;
    operateKeyId = operate.keyId;
    readKey = (await keys.issue("ops", { scope: "read", label: "ops-reader" })).key;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("refuses a read key every write with a 403 and changes nothing", async () => {
    const runId = await startRun();
    const eventsBefore = await database.pool.query("select 1 from run_events");
    const writes = api.routes.filter(
      (route) => route.method === "post" && !route.path.startsWith("/v1/codec/"),
    );
    expect(writes.length).toBe(23);
    for (const route of writes) {
      const path = route.path.replace(/\{(\w+)\}/g, (_match, name: string) =>
        name === "namespace" ? "ops" : name === "runId" ? runId : PLACEHOLDER_ID,
      );
      const reply = await call(readKey, "POST", path, {});
      expect(reply.status, `${route.operationId} ${path}`).toBe(403);
      expect(errorCode(reply)).toBe("forbidden");
    }
    const eventsAfter = await database.pool.query("select 1 from run_events");
    expect(eventsAfter.rowCount).toBe(eventsBefore.rowCount);
    expect(await auditEntries("ops")).toEqual([]);
  });

  it("lets a read key read but not reach the admin endpoints", async () => {
    expect((await call(readKey, "GET", "/v1/runs")).status).toBe(200);
    expect((await call(readKey, "GET", "/v1/quarantined-tasks")).status).toBe(200);
    expect((await call(readKey, "POST", "/v1/codec/decode", { payloads: [1] })).status).toBe(200);
    const admin = await call(readKey, "GET", "/v1/admin/namespaces");
    expect(admin.status).toBe(403);
    expect((admin.body["error"] as { message: string }).message).toContain("needs admin");
  });

  it("refuses an operate key every admin endpoint", async () => {
    const adminRoutes = api.routes.filter((route) => route.path.startsWith("/v1/admin/"));
    expect(adminRoutes).toHaveLength(8);
    for (const route of adminRoutes) {
      const path = route.path.replace(/\{(\w+)\}/g, (_match, name: string) =>
        name === "namespace" ? "ops" : PLACEHOLDER_ID,
      );
      const reply = await call(
        operateKey,
        route.method === "get" ? "GET" : "POST",
        path,
        route.method === "get" ? undefined : {},
      );
      expect(reply.status, route.operationId).toBe(403);
    }
  });

  it("answers 401 to a key once it expired", async () => {
    const expiring = await keys.issue("ops", {
      scope: "admin",
      expiresAt: new Date(now.getTime() + 60_000),
    });
    expect((await call(expiring.key, "GET", "/v1/runs")).status).toBe(200);
    now = new Date(now.getTime() + 60_000);
    const reply = await call(expiring.key, "GET", "/v1/runs");
    expect(reply.status).toBe(401);
    expect(errorCode(reply)).toBe("unauthorized");
    expect((await call(adminKey, "GET", "/v1/runs")).status).toBe(200);
  });

  it("creates a namespace, issues a scoped key for it and refuses keys for a missing one", async () => {
    const missing = await call(adminKey, "POST", "/v1/admin/namespaces/tenant-a/keys", {
      scope: "read",
    });
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("namespace_not_found");
    const exists = await database.pool.query("select 1 from namespaces where name = 'tenant-a'");
    expect(exists.rowCount).toBe(0);

    const created = await call(adminKey, "POST", "/v1/admin/namespaces", { name: "tenant-a" });
    expect(created.status).toBe(201);
    expect(
      (await call(adminKey, "POST", "/v1/admin/namespaces", { name: "tenant-a" })).status,
    ).toBe(200);
    const issued = await call(adminKey, "POST", "/v1/admin/namespaces/tenant-a/keys", {
      scope: "read",
      label: "dashboard",
    });
    expect(issued.status).toBe(201);
    const secret = issued.body["key"] as string;
    expect(secret).toMatch(/^dee_/);
    const described = await call(secret, "GET", "/v1/namespace");
    expect(described.body["name"]).toBe("tenant-a");
    expect((await call(secret, "POST", "/v1/runs", { workflowType: "order" })).status).toBe(403);

    const listed = await call(adminKey, "GET", "/v1/admin/namespaces/tenant-a/keys");
    const listedKeys = listed.body["keys"] as { keyId: string; lastUsedAt: string | null }[];
    expect(listedKeys).toHaveLength(1);
    expect(listedKeys[0]).toMatchObject({ scope: "read", label: "dashboard" });
    expect(listedKeys[0]?.lastUsedAt).toBe(now.toISOString());
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    const revoked = await call(
      adminKey,
      "POST",
      `/v1/admin/keys/${issued.body["keyId"] as string}/revoke`,
    );
    expect(revoked.status).toBe(200);
    expect((await call(secret, "GET", "/v1/namespace")).status).toBe(401);
    expect(
      (await call(adminKey, "POST", `/v1/admin/keys/${issued.body["keyId"] as string}/revoke`))
        .status,
    ).toBe(404);
  });

  it("reads and changes a namespace's quota, keeping the limits it is not given", async () => {
    const first = await call(adminKey, "POST", "/v1/admin/namespaces/ops/quota", {
      maxConcurrentRuns: 50,
      ratePerSecond: 20,
    });
    expect(first.status).toBe(200);
    const second = await call(adminKey, "POST", "/v1/admin/namespaces/ops/quota", {
      ratePerSecond: null,
    });
    expect(second.body["quota"]).toEqual({
      maxConcurrentRuns: 50,
      maxPendingTasks: null,
      ratePerSecond: null,
      burst: null,
    });
    const read = await call(adminKey, "GET", "/v1/admin/namespaces/ops/quota");
    expect(read.body["quota"]).toEqual(second.body["quota"]);
    expect((read.body["usage"] as { openRuns: number }).openRuns).toBeGreaterThan(0);
    expect((await call(adminKey, "GET", "/v1/admin/namespaces/nowhere/quota")).status).toBe(404);
    await call(adminKey, "POST", "/v1/admin/namespaces/ops/quota", { maxConcurrentRuns: null });
  });

  it("lists and releases the namespace's quarantined tasks, and no other namespace's", async () => {
    const runId = await startRun();
    const taskId = await quarantine(runId);
    const listed = await call(operateKey, "GET", "/v1/quarantined-tasks");
    expect(listed.body["tasks"]).toContainEqual(
      expect.objectContaining({ taskId, runId, reason: "lease lost 10 times", reclaimCount: 10 }),
    );
    await keys.ensureNamespace("intruders");
    const intruder = await keys.issue("intruders", { scope: "operate" });
    expect((await call(intruder.key, "GET", "/v1/quarantined-tasks")).body["tasks"]).toEqual([]);
    expect(
      (await call(intruder.key, "POST", `/v1/quarantined-tasks/${taskId}/release`)).status,
    ).toBe(404);

    const released = await call(operateKey, "POST", `/v1/quarantined-tasks/${taskId}/release`);
    expect(released).toEqual({ status: 200, body: { taskId, runId } });
    const row = await database.pool.query<{ state: string; reclaim_count: number }>(
      "select state, reclaim_count from tasks where id = $1",
      [taskId],
    );
    expect(row.rows[0]).toEqual({ state: "PENDING", reclaim_count: 0 });
    expect((await call(operateKey, "POST", `/v1/quarantined-tasks/${taskId}/release`)).status).toBe(
      404,
    );
  });

  it("writes every admin and operator action to the audit log with its actor", async () => {
    const cancelled = await startRun();
    const terminated = await startRun();
    const quarantinedRun = await startRun();
    const resetRun = await startRun();
    const taskId = await quarantine(quarantinedRun);
    const deadLetterId = await createDeadLetterQueue(database.pool).add({
      namespaceId: await namespaceIdOf("ops"),
      runId: cancelled,
      stepId: "step-1",
      queueName: `${QUEUE}/steps`,
      payload: { stepId: "step-1", stepType: "charge", input: {} },
      attempts: 3,
      error: { name: "ChargeError", message: "card declined" },
      reason: "MAX_ATTEMPTS_EXHAUSTED",
    });
    const before = (await auditEntries()).length;

    const operatorCalls: [string, string, unknown?][] = [
      ["/v1/pauses", "pause.create", { scope: "queue", reason: "deploy" }],
      ["/v1/pauses/resume", "pause.resume", { scope: "queue" }],
      [`/v1/runs/${cancelled}/cancel`, "run.cancel", { reason: "wrong order" }],
      [`/v1/runs/${terminated}/terminate`, "run.terminate", { reason: "stuck" }],
      [`/v1/dead-letters/${deadLetterId}/requeue`, "dead_letter.requeue"],
      [`/v1/quarantined-tasks/${taskId}/release`, "task.release"],
      [`/v1/runs/${resetRun}/fork`, "run.fork", { point: { kind: "event", sequence: 1 } }],
      [`/v1/runs/${resetRun}/reset`, "run.reset", { point: { kind: "event", sequence: 1 } }],
      ["/v1/batches", "batch.start", { operation: "cancel", query: "status = 'COMPLETED'" }],
    ];
    for (const [path, , body] of operatorCalls) {
      const reply = await call(operateKey, "POST", path, body ?? {});
      expect(reply.status, path).toBeLessThan(300);
    }
    const schedule = await call(operateKey, "POST", "/v1/schedules", {
      name: "hourly",
      cronExpression: "0 * * * *",
      workflowType: "order",
    });
    expect(schedule.status).toBe(201);
    const scheduleId = schedule.body["scheduleId"] as string;
    for (const suffix of ["pause", "resume"]) {
      expect((await call(operateKey, "POST", `/v1/schedules/${scheduleId}/${suffix}`)).status).toBe(
        200,
      );
    }
    const backfill = await call(operateKey, "POST", `/v1/schedules/${scheduleId}/backfill`, {
      from: "2030-01-01T00:00:00Z",
      to: "2030-01-01T02:00:00Z",
    });
    expect(backfill.status).toBe(200);

    await call(adminKey, "POST", "/v1/admin/namespaces", { name: "audited" });
    const issued = await call(adminKey, "POST", "/v1/admin/namespaces/audited/keys", {
      scope: "operate",
      label: "ci",
    });
    const issuedKeyId = issued.body["keyId"] as string;
    await call(adminKey, "POST", `/v1/admin/keys/${issuedKeyId}/revoke`);
    await call(adminKey, "POST", "/v1/admin/namespaces/audited/quota", { maxPendingTasks: 10 });

    const all = await auditEntries();
    const entries = all.slice(0, all.length - before);
    const audited = api.routes.flatMap((route) =>
      route.audit === undefined ? [] : [route.audit.action],
    );
    expect(new Set(entries.map((entry) => entry.action))).toEqual(new Set(audited));
    expect(entries).toHaveLength(audited.length);

    const byAction = new Map(entries.map((entry) => [entry.action, entry]));
    expect(byAction.get("run.terminate")).toMatchObject({
      namespace: "ops",
      target: terminated,
      details: { reason: "stuck" },
      actor: { keyId: operateKeyId, label: "ops-operator", namespace: "ops", scope: "operate" },
    });
    expect(byAction.get("pause.create")).toMatchObject({ target: "queue:" });
    expect(byAction.get("task.release")).toMatchObject({
      target: taskId,
      details: { runId: quarantinedRun },
    });
    expect(byAction.get("schedule.create")?.target).toBe(scheduleId);
    expect(byAction.get("key.issue")).toMatchObject({
      namespace: "audited",
      target: issuedKeyId,
      details: { scope: "operate", label: "ci" },
      actor: { keyId: adminKeyId, label: "ops-admin", scope: "admin" },
    });
    expect(JSON.stringify(entries)).not.toContain(issued.body["key"] as string);
    expect(byAction.get("key.revoke")).toMatchObject({ namespace: "audited", target: issuedKeyId });
    expect(byAction.get("quota.set")).toMatchObject({
      namespace: "audited",
      details: { maxPendingTasks: 10 },
    });
    expect((await auditEntries("audited")).map((entry) => entry.action)).toEqual([
      "quota.set",
      "key.revoke",
      "key.issue",
      "namespace.create",
    ]);
  });

  it("does not audit a refused or failed action", async () => {
    const before = (await auditEntries()).length;
    expect(
      (await call(operateKey, "POST", `/v1/runs/${PLACEHOLDER_ID}/terminate`, {})).status,
    ).toBe(404);
    expect((await call(readKey, "POST", "/v1/pauses", { scope: "namespace" })).status).toBe(403);
    expect((await auditEntries()).length).toBe(before);
  });

  it("keeps the audit log append-only", async () => {
    await expect(database.pool.query("update audit_log set action = 'forged'")).rejects.toThrow(
      /append-only/,
    );
    await expect(database.pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
  });

  it("pages the audit log newest first with a cursor", async () => {
    const ids = (await auditEntries()).map((entry) => Number((entry as { id?: string }).id));
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toEqual([...ids].sort((left, right) => right - left));
    const first = await call(adminKey, "GET", "/v1/admin/audit-log?limit=2");
    const entries = first.body["entries"] as { id: string }[];
    expect(entries).toHaveLength(2);
    const cursor = first.body["nextCursor"] as string;
    expect(cursor).toBe(entries[1]?.id);
    const second = await call(adminKey, "GET", `/v1/admin/audit-log?limit=2&cursor=${cursor}`);
    const next = second.body["entries"] as { id: string }[];
    expect(Number(next[0]?.id)).toBeLessThan(Number(cursor));
  });
});
