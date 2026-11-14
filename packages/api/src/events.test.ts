import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { defineWorkflow } from "../../core/src/workflow/define-workflow.ts";
import { createWorkflowRegistry } from "../../core/src/workflow/workflow-registry.ts";
import { createRunService } from "./run-service.ts";
import { createApiServer } from "./server.ts";

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const inbox = defineWorkflow("inbox", async (ctx) => ctx.waitForSignal("item"));
const onOrder = defineWorkflow("on-order", (_ctx, input: unknown) => Promise.resolve(input));

describe("event and signal endpoints", () => {
  let database: IsolatedSchema;
  let baseUrl: string;
  let key: string;
  let closeServer: () => Promise<void>;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const workflows = createWorkflowRegistry();
    workflows.register(inbox);
    workflows.register(onOrder);
    const service = createRunService(database.pool, { queueName: "default", workflows });
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
    key = (await api.apiKeys.issue("events")).key;
  });

  afterAll(async () => {
    await closeServer();
    await database.close();
  });

  it("records a signal id once and answers the repeat as a duplicate", async () => {
    const started = await call("POST", "/v1/runs", { workflowType: "inbox" });
    const runId = (started.body["run"] as { runId: string }).runId;

    const first = await call("POST", `/v1/runs/${runId}/signal`, {
      name: "item",
      payload: 1,
      signalId: "invoice-9",
    });
    const second = await call("POST", `/v1/runs/${runId}/signal`, {
      name: "item",
      payload: 1,
      signalId: "invoice-9",
    });

    expect(first).toEqual({
      status: 200,
      body: { runId, sequenceNumber: 2, duplicate: false },
    });
    expect(second).toEqual({ status: 200, body: { runId, sequenceNumber: 2, duplicate: true } });
    const history = await call("GET", `/v1/runs/${runId}/history`);
    expect(history.body["events"]).toHaveLength(2);
  });

  it("starts a run once with signal-with-start and signals it on the next call", async () => {
    const request = (payload: number): unknown => ({
      workflowType: "inbox",
      workflowKey: "cart-1",
      signal: { name: "item", payload },
    });

    const first = await call("POST", "/v1/signal-with-start", request(1));
    const second = await call("POST", "/v1/signal-with-start", request(2));

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, duplicate: false, sequenceNumber: 2 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      created: false,
      runId: first.body["runId"],
      sequenceNumber: 3,
    });
  });

  it("refuses signal-with-start for an unknown workflow type and a key of another type", async () => {
    const unknown = await call("POST", "/v1/signal-with-start", {
      workflowType: "nobody",
      workflowKey: "k",
      signal: { name: "item" },
    });
    await call("POST", "/v1/signal-with-start", {
      workflowType: "inbox",
      workflowKey: "shared-key",
      signal: { name: "item" },
    });
    const conflict = await call("POST", "/v1/signal-with-start", {
      workflowType: "on-order",
      workflowKey: "shared-key",
      signal: { name: "item" },
    });

    expect(unknown.status).toBe(400);
    expect(conflict.status).toBe(409);
    expect((conflict.body["error"] as { code: string }).code).toBe("workflow_key_conflict");
  });

  it("registers a trigger and starts a run for a matching event", async () => {
    const trigger = await call("POST", "/v1/event-triggers", {
      eventName: "order.placed",
      key: "eu",
      workflowType: "on-order",
    });
    expect(trigger.status).toBe(201);
    expect(trigger.body).toMatchObject({
      eventName: "order.placed",
      key: "eu",
      workflowType: "on-order",
      queueName: "default",
    });

    const matching = await call("POST", "/v1/events", {
      name: "order.placed",
      key: "eu",
      payload: { orderId: "o-1" },
    });
    const other = await call("POST", "/v1/events", { name: "order.placed", key: "us" });

    expect(matching.status).toBe(202);
    expect(matching.body["startedRunIds"]).toHaveLength(1);
    expect(matching.body["deliveredTo"]).toEqual([]);
    expect(other.body["startedRunIds"]).toEqual([]);
    const runId = (matching.body["startedRunIds"] as string[])[0] ?? "";
    const run = await call("GET", `/v1/runs/${runId}`);
    expect(run.body).toMatchObject({
      workflowType: "on-order",
      input: {
        eventId: matching.body["eventId"],
        eventName: "order.placed",
        key: "eu",
        payload: { orderId: "o-1" },
      },
    });
    const listed = await call("GET", "/v1/event-triggers");
    expect(listed.body["triggers"]).toEqual([trigger.body]);
  });

  it("refuses an event with a buffer out of range and a trigger for an unknown type", async () => {
    const before = await database.pool.query("select 1 from external_events");
    const event = await call("POST", "/v1/events", { name: "e", key: "k", bufferMs: -5 });
    const trigger = await call("POST", "/v1/event-triggers", {
      eventName: "e",
      workflowType: "nobody",
    });

    expect(event.status).toBe(400);
    expect(trigger.status).toBe(400);
    const after = await database.pool.query("select 1 from external_events");
    expect(after.rowCount).toBe(before.rowCount);
    expect((await call("GET", "/v1/event-triggers")).body["triggers"]).not.toContainEqual(
      expect.objectContaining({ workflowType: "nobody" }),
    );
  });
});
