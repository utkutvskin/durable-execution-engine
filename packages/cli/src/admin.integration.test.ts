import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKeyStore, createApiServer } from "@dee/api";
import { createDeadLetterQueue } from "@dee/core";
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

describe("wf admin and operator commands against a real api", () => {
  let database: IsolatedSchema;
  let url: string;
  let adminKey: string;
  let namespaceId: string;
  let closeServer: () => Promise<void>;

  async function wf(apiKey: string, ...argv: string[]) {
    const captured = captureIo({ WF_API_URL: url, WF_API_KEY: apiKey });
    const code = await main(argv, captured.io, { now: () => new Date("2030-01-01T00:00:00Z") });
    return { code, out: captured.out, err: captured.err };
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const keys = createApiKeyStore(database.pool, {
      clock: { now: () => new Date("2030-01-01T00:00:00Z") },
    });
    const api = createApiServer(database.pool, { queueName: "default", apiKeys: keys });
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${String((api.server.address() as AddressInfo).port)}`;
    closeServer = () =>
      new Promise<void>((resolve) => {
        api.server.close(() => {
          resolve();
        });
        api.server.closeAllConnections();
      });
    namespaceId = await keys.ensureNamespace("ops");
    adminKey = (await keys.issue("ops", { scope: "admin", label: "root" })).key;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("creates a namespace and issues, lists and revokes a scoped key that expires", async () => {
    expect(await wf(adminKey, "keys", "issue", "tenant", "--scope", "read")).toMatchObject({
      code: 1,
    });
    expect(await wf(adminKey, "namespace", "create", "tenant")).toMatchObject({
      code: 0,
      out: ["created namespace tenant"],
    });
    expect((await wf(adminKey, "namespace", "create", "tenant")).out).toEqual([
      "namespace tenant exists already",
    ]);
    const issued = await wf(
      adminKey,
      "keys",
      "issue",
      "tenant",
      "--scope",
      "read",
      "--label",
      "grafana",
      "--expires-in",
      "3600",
      "--json",
    );
    expect(issued.code).toBe(0);
    const key = JSON.parse(issued.out[0] ?? "{}") as {
      key: string;
      keyId: string;
      expiresAt: string;
    };
    expect(key.expiresAt).toBe("2030-01-01T01:00:00.000Z");
    expect(key.key).toMatch(/^dee_/);

    const listed = await wf(adminKey, "keys", "list", "tenant");
    expect(listed.out).toHaveLength(1);
    expect(listed.out[0]).toContain(`${key.keyId}  read    grafana`);
    expect(listed.out[0]).toContain("expires 2030-01-01T01:00:00.000Z");

    const names = await wf(adminKey, "namespace", "list", "--json");
    expect(
      (JSON.parse(names.out[0] ?? "{}") as { namespaces: { name: string }[] }).namespaces.map(
        (namespace) => namespace.name,
      ),
    ).toEqual(["ops", "tenant"]);

    expect(await wf(adminKey, "keys", "revoke", key.keyId)).toMatchObject({
      code: 0,
      out: [`revoked key ${key.keyId} of tenant`],
    });
    expect((await wf(adminKey, "keys", "list", "tenant")).out[0]).toContain("revoked");
  });

  it("refuses an operator action to a read key with the scope it needs", async () => {
    const issued = await wf(adminKey, "keys", "issue", "ops", "--scope", "read", "--json");
    const readKey = (JSON.parse(issued.out[0] ?? "{}") as { key: string }).key;
    const runId = (await wf(adminKey, "run", "start", "order")).out[0] ?? "";
    const refused = await wf(readKey, "run", "terminate", runId);
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).toContain("terminateRun needs operate");
    expect((await wf(readKey, "dlq", "list")).code).toBe(0);
  });

  it("sets and reads a quota, removing a limit with none", async () => {
    expect(
      (
        await wf(
          adminKey,
          "quota",
          "set",
          "ops",
          "--max-concurrent-runs",
          "25",
          "--rate-per-second",
          "5",
        )
      ).code,
    ).toBe(0);
    await wf(adminKey, "quota", "set", "ops", "--rate-per-second", "none");
    const shown = await wf(adminKey, "quota", "get", "ops");
    expect(shown.out[1]).toMatch(/^max concurrent runs {2}25 \(open \d+\)$/);
    expect(shown.out[3]).toBe("rate per second      none");
    expect((await wf(adminKey, "quota", "set", "ops")).code).toBe(2);
    expect((await wf(adminKey, "quota", "set", "ops", "--burst", "-1")).code).toBe(2);
    await wf(adminKey, "quota", "set", "ops", "--max-concurrent-runs", "none");
  });

  it("terminates a run, requeues a dead letter and releases a quarantined task", async () => {
    const terminated = (await wf(adminKey, "run", "start", "order")).out[0] ?? "";
    expect(await wf(adminKey, "run", "terminate", terminated, "--reason", "stuck")).toMatchObject({
      code: 0,
      out: [`terminated ${terminated}`],
    });
    const status = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [terminated],
    );
    expect(status.rows[0]?.status).toBe("TERMINATED");

    const runId = (await wf(adminKey, "run", "start", "order")).out[0] ?? "";
    const deadLetterId = await createDeadLetterQueue(database.pool).add({
      namespaceId,
      runId,
      stepId: "step-1",
      queueName: "default/steps",
      payload: { stepId: "step-1", stepType: "charge", input: {} },
      attempts: 3,
      error: { name: "ChargeError", message: "card declined" },
      reason: "MAX_ATTEMPTS_EXHAUSTED",
    });
    const letters = await wf(adminKey, "dlq", "list");
    expect(letters.out.join("\n")).toContain(`${deadLetterId}  run ${runId}  step step-1`);
    const requeued = await wf(adminKey, "dlq", "requeue", deadLetterId);
    expect(requeued.code).toBe(0);
    expect(requeued.out[0]).toMatch(new RegExp(`^requeued ${deadLetterId} as task `));
    expect((await wf(adminKey, "dlq", "list")).out).toEqual(["the dead letter queue is empty"]);

    const task = await database.pool.query<{ id: string }>(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, state, quarantined_at,
                          quarantine_reason)
       values ($1, $2, 'default/steps', 'STEP_TASK', 'QUARANTINED', now(), 'boom') returning id`,
      [namespaceId, runId],
    );
    const taskId = task.rows[0]?.id ?? "";
    expect((await wf(adminKey, "quarantine", "list")).out[0]).toContain(`${taskId}  run ${runId}`);
    expect(await wf(adminKey, "quarantine", "release", taskId)).toMatchObject({
      code: 0,
      out: [`released task ${taskId} of run ${runId}`],
    });
    expect((await wf(adminKey, "quarantine", "list")).out).toEqual(["no task is quarantined"]);
    expect((await wf(adminKey, "quarantine", "release", taskId)).code).toBe(1);
  });

  it("lists the audit log with the actor of each action", async () => {
    const shown = await wf(adminKey, "audit", "list", "--namespace", "ops", "--limit", "3");
    expect(shown.code).toBe(0);
    expect(shown.out).toHaveLength(3);
    expect(shown.out[0]).toMatch(/task\.release +ops +[0-9a-f-]{36} +root \(admin@ops\)$/);
    const json = await wf(adminKey, "audit", "list", "--json");
    const actions = (JSON.parse(json.out[0] ?? "{}") as { entries: { action: string }[] }).entries
      .map((entry) => entry.action)
      .reverse();
    expect(actions).toEqual([
      "namespace.create",
      "namespace.create",
      "key.issue",
      "key.revoke",
      "key.issue",
      "quota.set",
      "quota.set",
      "quota.set",
      "run.terminate",
      "dead_letter.requeue",
      "task.release",
    ]);
    expect((await wf(adminKey, "audit", "list", "--limit", "0")).code).toBe(2);
  });

  it("names the missing action and refuses an unknown one with exit code 2", async () => {
    expect((await wf(adminKey, "keys")).err).toEqual([
      "error: missing keys action: issue, list, revoke",
    ]);
    expect((await wf(adminKey, "namespace", "drop", "ops")).code).toBe(2);
    expect((await wf(adminKey, "keys", "issue", "ops", "--scope", "root")).code).toBe(2);
    expect(
      (
        await wf(
          adminKey,
          "keys",
          "issue",
          "ops",
          "--scope",
          "read",
          "--expires-in",
          "60",
          "--expires-at",
          "2031-01-01T00:00:00Z",
        )
      ).code,
    ).toBe(2);
    expect((await wf(adminKey, "dlq")).code).toBe(2);
    expect((await wf(adminKey, "quarantine", "purge")).code).toBe(2);
  });
});
