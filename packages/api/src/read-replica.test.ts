import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClockSource } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { createApiKeyStore } from "./api-keys.ts";
import { createRunService, DEFAULT_READ_YOUR_WRITES_MS, type RunService } from "./run-service.ts";
import { createApiServer } from "./server.ts";
import { issueTestKey } from "./test-keys.ts";

describe("reads from a read replica", () => {
  let primary: IsolatedSchema;
  let replica: IsolatedSchema;
  let namespaceId: string;
  let now: Date;
  let service: RunService;
  const clock: ClockSource = { now: () => now };

  beforeAll(async () => {
    primary = await createIsolatedDatabase();
    replica = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await primary.close();
    await replica.close();
  });

  beforeEach(async () => {
    for (const database of [primary, replica]) {
      await database.pool.query("truncate namespaces cascade");
    }
    const created = await primary.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
    await replica.pool.query("insert into namespaces (id, name) values ($1, 'default')", [
      namespaceId,
    ]);
    now = new Date("2030-01-01T00:00:00.000Z");
    service = createRunService(primary.pool, {
      queueName: "default",
      clock,
      readPool: replica.pool,
    });
  });

  async function replicate(runId: string): Promise<void> {
    await replica.pool.query(
      `insert into workflow_runs select * from "${primary.schema}".workflow_runs where id = $1`,
      [runId],
    );
    await replica.pool.query(
      `insert into run_events (run_id, sequence_number, event_type, payload, created_at,
                               event_version, run_created_at)
       select run_id, sequence_number, event_type, payload, created_at, event_version,
              run_created_at
       from "${primary.schema}".run_events where run_id = $1`,
      [runId],
    );
  }

  async function startUnseen(workflowType: string): Promise<string> {
    const started = await createRunService(primary.pool, { queueName: "default" }).startRun(
      namespaceId,
      { workflowType },
    );
    return started.run.runId;
  }

  function idsOf(page: { runs: readonly { runId: string }[] }): string[] {
    return page.runs.map((run) => run.runId).sort();
  }

  it("lists runs and reads histories from the replica", async () => {
    const replicated = await startUnseen("order");
    await replicate(replicated);
    const notYetReplicated = await startUnseen("order");
    await replica.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [
      replicated,
    ]);

    expect(idsOf(await service.listRuns(namespaceId, { limit: 10 }))).toEqual([replicated]);
    expect((await service.describeRun(namespaceId, replicated)).status).toBe("COMPLETED");
    expect((await service.getHistory(namespaceId, replicated)).events).toHaveLength(1);
    expect((await service.describeRun(namespaceId, notYetReplicated)).status).toBe("RUNNING");
  });

  it("reads a run it just started from the primary until the window passes", async () => {
    const started = await service.startRun(namespaceId, { workflowType: "order" });
    const runId = started.run.runId;

    expect(idsOf(await service.listRuns(namespaceId, { limit: 10 }))).toEqual([runId]);
    expect((await service.getHistory(namespaceId, runId)).events).toHaveLength(1);

    await replicate(runId);
    await replica.pool.query("update workflow_runs set status = 'FAILED' where id = $1", [runId]);
    expect((await service.describeRun(namespaceId, runId)).status).toBe("RUNNING");
    now = new Date(now.getTime() + DEFAULT_READ_YOUR_WRITES_MS);
    expect((await service.describeRun(namespaceId, runId)).status).toBe("FAILED");
  });

  it("reads a run's history from the primary right after a signal", async () => {
    const runId = await startUnseen("order");
    await replicate(runId);

    await service.signalRun(namespaceId, runId, "go", { bonus: 1 });

    const fresh = await service.getHistory(namespaceId, runId);
    expect(fresh.events.map((entry) => entry.event.type)).toEqual([
      "run_started",
      "signal_received",
    ]);
    now = new Date(now.getTime() + DEFAULT_READ_YOUR_WRITES_MS + 1);
    const stale = await service.getHistory(namespaceId, runId);
    expect(stale.events.map((entry) => entry.event.type)).toEqual(["run_started"]);
  });

  it("serves list and metrics reads over http from the replica", async () => {
    const replicated = await startUnseen("order");
    await replicate(replicated);
    await startUnseen("order");
    await replica.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type)
       select $1, $2, 'default', 'STEP_TASK' from generate_series(1, 7)`,
      [namespaceId, replicated],
    );
    const keys = createApiKeyStore(primary.pool);
    const issued = await issueTestKey(keys, "default", { label: "replica test" });
    const { server } = createApiServer(primary.pool, {
      queueName: "default",
      apiKeys: keys,
      readPool: replica.pool,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const listed = await fetch(`http://127.0.0.1:${String(port)}/v1/runs`, {
        headers: { authorization: `Bearer ${issued.key}` },
      });
      const body = (await listed.json()) as { runs: { runId: string }[] };
      expect(idsOf(body)).toEqual([replicated]);

      const metrics = await (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();
      expect(metrics).toMatch(/^dee_queue_depth\{queue="default"\} 7$/m);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
