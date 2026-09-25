import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "./event-store.js";
import { ConcurrencyError } from "./errors.js";
import type { WorkflowEvent } from "./events.js";

async function insertRun(database: IsolatedSchema): Promise<string> {
  const namespace = await database.pool.query<{ id: string }>(
    "insert into namespaces (name) values ('acme') returning id",
  );
  const namespaceId = namespace.rows[0]?.id;
  if (namespaceId === undefined) {
    throw new Error("failed to insert namespace fixture");
  }
  const run = await database.pool.query<{ id: string }>(
    "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
    [namespaceId],
  );
  const runId = run.rows[0]?.id;
  if (runId === undefined) {
    throw new Error("failed to insert workflow_runs fixture");
  }
  return runId;
}

describe("createPostgresEventStore", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let runId: string;

  beforeEach(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    runId = await insertRun(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("exposes only append and read, never an update or a delete", () => {
    expect(Object.keys(store).sort()).toEqual(["append", "read"]);
  });

  it("assigns consecutive sequence numbers starting at expectedSeq + 1", async () => {
    const events: WorkflowEvent[] = [
      { type: "run_started", workflowType: "ship-order", input: {} },
      { type: "step_scheduled", stepId: "charge-card", stepType: "charge-card", input: {} },
    ];
    const stored = await store.append(runId, 0, events);
    expect(stored.map((entry) => entry.sequenceNumber)).toEqual([1, 2]);
    expect(stored.map((entry) => entry.event)).toEqual(events);
  });

  it("returns an empty array without writing anything when events is empty", async () => {
    const stored = await store.append(runId, 0, []);
    expect(stored).toEqual([]);
    expect(await store.read(runId)).toEqual([]);
  });

  it("reads back an appended history in ascending sequence order", async () => {
    await store.append(runId, 0, [{ type: "run_started", workflowType: "ship-order", input: {} }]);
    await store.append(runId, 1, [
      { type: "step_scheduled", stepId: "charge-card", stepType: "charge-card", input: { amount: 42 } },
    ]);

    const history = await store.read(runId);
    expect(history.map((entry) => entry.sequenceNumber)).toEqual([1, 2]);
    expect(history[1]?.event).toEqual({
      type: "step_scheduled",
      stepId: "charge-card",
      stepType: "charge-card",
      input: { amount: 42 },
    });
  });

  it("reads only the events after fromSeq", async () => {
    await store.append(runId, 0, [
      { type: "run_started", workflowType: "ship-order", input: {} },
      { type: "step_scheduled", stepId: "charge-card", stepType: "charge-card", input: {} },
      { type: "step_completed", stepId: "charge-card", result: {} },
    ]);

    const history = await store.read(runId, 1);
    expect(history.map((entry) => entry.sequenceNumber)).toEqual([2, 3]);
  });

  it("rejects a stale expectedSeq with ConcurrencyError and writes nothing", async () => {
    await store.append(runId, 0, [{ type: "run_started", workflowType: "ship-order", input: {} }]);

    await expect(
      store.append(runId, 0, [
        { type: "step_scheduled", stepId: "charge-card", stepType: "charge-card", input: {} },
      ]),
    ).rejects.toThrow(ConcurrencyError);

    expect(await store.read(runId)).toHaveLength(1);
  });

  it("rejects an event that fails schema validation before writing anything", async () => {
    await expect(
      store.append(runId, 0, [
        { type: "run_started" } as unknown as WorkflowEvent,
      ]),
    ).rejects.toThrow();

    expect(await store.read(runId)).toEqual([]);
  });

  it("lets exactly one of 50 concurrent appends with the same expectedSeq win", async () => {
    const attempts = Array.from({ length: 50 }, (_, index) =>
      store.append(runId, 0, [
        { type: "step_scheduled", stepId: `step-${String(index)}`, stepType: "charge-card", input: {} },
      ]),
    );
    const settled = await Promise.allSettled(attempts);

    const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled");
    const rejected = settled.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(49);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(ConcurrencyError);
    }

    const history = await store.read(runId);
    expect(history).toHaveLength(1);
    expect(history[0]?.sequenceNumber).toBe(1);
  });
});
