import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import {
  createPostgresEventStore,
  type EventStore,
} from "../../core/src/event-store/event-store.ts";
import { commandToEvent } from "../../core/src/workflow/command-events.ts";
import { runDecisionLoop } from "../../core/src/workflow/decision-loop.ts";
import { defineUpdate } from "../../core/src/workflow/define-update.ts";
import { defineWorkflow } from "../../core/src/workflow/define-workflow.ts";
import { systemClock } from "../../core/src/workflow/sources.ts";
import { createWorkflowRegistry } from "../../core/src/workflow/workflow-registry.ts";
import { createRunService } from "./run-service.ts";
import { createApiServer } from "./server.ts";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const ledger = defineWorkflow("ledger", async (ctx) => {
  let balance = 0;
  ctx.setQueryHandler("balance", () => balance);
  ctx.setQueryHandler("projected", (extra) => balance + Number(extra));
  ctx.setUpdateHandler(
    defineUpdate<number, number>("deposit", {
      validate: (amount) => {
        if (typeof amount !== "number" || amount <= 0) {
          throw new Error("a deposit must be a positive number");
        }
      },
      handler: (amount) => {
        balance += amount;
        return balance;
      },
    }),
  );
  ctx.setUpdateHandler(
    defineUpdate("overdraw", {
      handler: () => {
        throw new Error("the ledger cannot go below zero");
      },
    }),
  );
  await ctx.waitForSignal("close");
  return balance;
});

describe("update and query endpoints", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let baseUrl: string;
  let key: string;
  let otherKey: string;
  let closeServer: () => Promise<void>;
  let decide: boolean;

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

  async function decideOpenRuns(): Promise<void> {
    if (!decide) {
      return;
    }
    const runs = await database.pool.query<{ id: string }>(
      "select id from workflow_runs where status = 'RUNNING'",
    );
    for (const { id } of runs.rows) {
      const stored = await store.read(id);
      const decision = await runDecisionLoop(
        ledger.handler,
        {},
        stored.map((entry) => entry.event),
        { clock: systemClock, runId: id },
      );
      await store.append(
        id,
        stored.at(-1)?.sequenceNumber ?? 0,
        decision.commands.map(commandToEvent),
      );
    }
  }

  async function eventCount(runId: string): Promise<number> {
    return (await store.read(runId)).length;
  }

  async function startLedger(apiKey = key): Promise<string> {
    const reply = await call(apiKey, "POST", "/v1/runs", { workflowType: "ledger" });
    expect(reply.status).toBe(201);
    return (reply.body["run"] as { runId: string }).runId;
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    const workflows = createWorkflowRegistry();
    workflows.register(ledger);
    const service = createRunService(database.pool, {
      queueName: "default",
      workflows,
      updateWait: { pollMs: 10, nowMs: () => 0, sleep: () => decideOpenRuns() },
    });
    const api = createApiServer(database.pool, { queueName: "default", service, workflows });
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
    key = (await api.apiKeys.issue("updates")).key;
    otherKey = (await api.apiKeys.issue("someone-else")).key;
  });

  beforeEach(() => {
    decide = true;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("returns the result of an update that passed validation", async () => {
    const runId = await startLedger();

    const first = await call(key, "POST", `/v1/runs/${runId}/updates/deposit`, {
      argument: 30,
      updateId: "deposit-1",
    });
    const second = await call(key, "POST", `/v1/runs/${runId}/updates/deposit`, {
      argument: 12,
    });

    expect(first).toEqual({
      status: 200,
      body: { status: "completed", updateId: "deposit-1", sequenceNumber: 2, result: 30 },
    });
    expect(second.status).toBe(200);
    expect(second.body["result"]).toBe(42);
    const history = await call(key, "GET", `/v1/runs/${runId}/history`);
    expect(
      (history.body["events"] as { event: { type: string } }[]).map((entry) => entry.event.type),
    ).toEqual([
      "run_started",
      "update_accepted",
      "update_completed",
      "update_accepted",
      "update_completed",
    ]);
  });

  it("answers 400 for a rejected update and writes nothing", async () => {
    const runId = await startLedger();
    const before = await eventCount(runId);

    const rejected = await call(key, "POST", `/v1/runs/${runId}/updates/deposit`, {
      argument: -5,
    });
    const unknown = await call(key, "POST", `/v1/runs/${runId}/updates/withdraw`, {
      argument: 5,
    });

    expect(rejected).toEqual({
      status: 400,
      body: {
        error: {
          code: "update_rejected",
          message: 'update "deposit" was rejected: a deposit must be a positive number',
        },
      },
    });
    expect(unknown.status).toBe(400);
    expect((unknown.body["error"] as { code: string }).code).toBe("unknown_update");
    expect(await eventCount(runId)).toBe(before);
    const tasks = await database.pool.query("select 1 from tasks where run_id = $1", [runId]);
    expect(tasks.rowCount).toBe(1);
  });

  it("reports a handler that threw as a failed update", async () => {
    const runId = await startLedger();

    const reply = await call(key, "POST", `/v1/runs/${runId}/updates/overdraw`, {});

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      status: "failed",
      error: { name: "Error", message: "the ledger cannot go below zero" },
    });
  });

  it("answers 202 when the wait ends before the update ran", async () => {
    const runId = await startLedger();
    decide = false;

    const reply = await call(key, "POST", `/v1/runs/${runId}/updates/deposit`, {
      argument: 1,
      waitMs: 0,
    });

    expect(reply).toEqual({
      status: 202,
      body: { status: "accepted", updateId: expect.any(String) as unknown, sequenceNumber: 2 },
    });
  });

  it("answers a query from current state without writing an event", async () => {
    const runId = await startLedger();
    await call(key, "POST", `/v1/runs/${runId}/updates/deposit`, { argument: 8 });
    const before = await eventCount(runId);

    const balance = await call(key, "GET", `/v1/runs/${runId}/queries/balance`);
    const projected = await call(
      key,
      "GET",
      `/v1/runs/${runId}/queries/projected?argument=${encodeURIComponent("2")}`,
    );

    expect(balance).toEqual({ status: 200, body: { result: 8 } });
    expect(projected).toEqual({ status: 200, body: { result: 10 } });
    expect(await eventCount(runId)).toBe(before);
  });

  it("refuses an unknown query, a malformed argument and another namespace's run", async () => {
    const runId = await startLedger();

    const unknown = await call(key, "GET", `/v1/runs/${runId}/queries/owner`);
    const malformed = await call(key, "GET", `/v1/runs/${runId}/queries/projected?argument={`);
    const foreignQuery = await call(otherKey, "GET", `/v1/runs/${runId}/queries/balance`);
    const foreignUpdate = await call(otherKey, "POST", `/v1/runs/${runId}/updates/deposit`, {
      argument: 1,
    });

    expect(unknown.status).toBe(400);
    expect((unknown.body["error"] as { code: string }).code).toBe("unknown_query");
    expect(malformed.status).toBe(400);
    expect((malformed.body["error"] as { code: string }).code).toBe("validation_failed");
    expect(foreignQuery.status).toBe(404);
    expect(foreignUpdate.status).toBe(404);
  });

  it("answers 409 for an update to a closed run", async () => {
    const runId = await startLedger();
    await database.pool.query("update workflow_runs set status = 'COMPLETED' where id = $1", [
      runId,
    ]);

    const reply = await call(key, "POST", `/v1/runs/${runId}/updates/deposit`, { argument: 1 });

    expect(reply.status).toBe(409);
    expect((reply.body["error"] as { code: string }).code).toBe("run_closed");
  });

  it("answers 501 when the api has no code for the run's workflow", async () => {
    const bare = createApiServer(database.pool, { queueName: "default" });
    await new Promise<void>((resolve) => bare.server.listen(0, "127.0.0.1", resolve));
    const { port } = bare.server.address() as AddressInfo;
    const runId = await startLedger();
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/v1/runs/${runId}/queries/balance`,
        { headers: { authorization: `Bearer ${key}` } },
      );
      const body = (await response.json()) as { error: { code: string } };
      expect(response.status).toBe(501);
      expect(body.error.code).toBe("workflow_not_loaded");
    } finally {
      await new Promise<void>((resolve) => {
        bare.server.close(() => {
          resolve();
        });
        bare.server.closeAllConnections();
      });
    }
  });
});
