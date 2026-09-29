import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { InvalidTransitionError } from "./errors.js";
import { rebuildProjection, refreshProjection } from "./projection-store.js";

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error("cannot pick from an empty list");
  }
  return item;
}

function randomHistory(random: () => number): WorkflowEvent[] {
  const events: WorkflowEvent[] = [
    { type: "run_started", workflowType: "ship-order", input: { n: Math.floor(random() * 100) } },
  ];
  const middleCount = Math.floor(random() * 6);
  for (let index = 0; index < middleCount; index += 1) {
    const stepId = `step-${String(index)}`;
    events.push(
      pick<WorkflowEvent>(random, [
        { type: "step_scheduled", stepId, stepType: "charge-card", input: { index } },
        { type: "step_completed", stepId, result: { index } },
        { type: "step_failed", stepId, error: { name: "Error", message: "boom" } },
        {
          type: "timer_started",
          timerId: `timer-${String(index)}`,
          fireAt: "2026-01-01T00:00:00Z",
        },
        { type: "timer_fired", timerId: `timer-${String(index)}` },
      ]),
    );
  }
  if (random() < 0.8) {
    events.push(
      pick<WorkflowEvent>(random, [
        { type: "run_completed", result: { total: Math.floor(random() * 1000) } },
        { type: "run_failed", error: { name: "Error", message: "gave up" } },
        { type: "run_timed_out" },
        { type: "run_cancelled", reason: "requested" },
        { type: "run_terminated" },
      ]),
    );
  }
  return events;
}

describe("run projection store", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('acme') returning id",
    );
    const id = namespace.rows[0]?.id;
    if (id === undefined) {
      throw new Error("failed to insert namespace fixture");
    }
    namespaceId = id;
  });

  afterAll(async () => {
    await database.close();
  });

  async function insertRun(): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespaceId],
    );
    const id = run.rows[0]?.id;
    if (id === undefined) {
      throw new Error("failed to insert workflow_runs fixture");
    }
    return id;
  }

  async function snapshot(runId: string): Promise<unknown> {
    const result = await database.pool.query(
      `select status, input, result, error, closed_at, last_sequence_number
       from workflow_runs where id = $1`,
      [runId],
    );
    return result.rows[0];
  }

  async function wipeProjection(runId: string): Promise<void> {
    await database.pool.query(
      `update workflow_runs
       set status = 'RUNNING', input = '{}'::jsonb, result = null, error = null,
           closed_at = null, last_sequence_number = 0
       where id = $1`,
      [runId],
    );
  }

  it("refreshes a run through its history into a COMPLETED row", async () => {
    const runId = await insertRun();
    await store.append(runId, 0, [
      { type: "run_started", workflowType: "ship-order", input: { orderId: 9 } },
      { type: "run_completed", result: { ok: true } },
    ]);
    const projection = await refreshProjection(database.pool, store, runId);
    expect(projection.state).toBe("COMPLETED");
    expect(await snapshot(runId)).toMatchObject({
      status: "COMPLETED",
      input: { orderId: 9 },
      result: { ok: true },
      last_sequence_number: "2",
    });
  });

  it("only folds events after the last refreshed sequence number", async () => {
    const runId = await insertRun();
    await store.append(runId, 0, [{ type: "run_started", workflowType: "ship-order", input: {} }]);
    await refreshProjection(database.pool, store, runId);
    await store.append(runId, 1, [{ type: "run_cancelled", reason: "user" }]);
    const projection = await refreshProjection(database.pool, store, runId);
    expect(projection.state).toBe("CANCELLED");
    expect(projection.lastSequenceNumber).toBe(2);
  });

  it("rejects an event after a terminal state and leaves the row untouched", async () => {
    const runId = await insertRun();
    await store.append(runId, 0, [
      { type: "run_started", workflowType: "ship-order", input: {} },
      { type: "run_terminated" },
    ]);
    await refreshProjection(database.pool, store, runId);
    const before = await snapshot(runId);
    await store.append(runId, 2, [
      { type: "step_scheduled", stepId: "step-0", stepType: "charge-card", input: {} },
    ]);
    await expect(refreshProjection(database.pool, store, runId)).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(await snapshot(runId)).toEqual(before);
  });

  it("rejects a projection for a run that does not exist", async () => {
    await expect(
      refreshProjection(database.pool, store, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses to store a status outside the six run states", async () => {
    const runId = await insertRun();
    await expect(
      database.pool.query("update workflow_runs set status = 'PAUSED' where id = $1", [runId]),
    ).rejects.toThrow(/workflow_runs_status_check/);
  });

  it("rebuilds an identical projection from scratch for 200 random event sequences", async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = createRandom(seed);
      const runId = await insertRun();
      const history = randomHistory(random);

      let appended = 0;
      while (appended < history.length) {
        const chunkSize = 1 + Math.floor(random() * 3);
        const chunk = history.slice(appended, appended + chunkSize);
        await store.append(runId, appended, chunk);
        appended += chunk.length;
        await refreshProjection(database.pool, store, runId);
      }

      const incremental = await snapshot(runId);
      await wipeProjection(runId);
      await rebuildProjection(database.pool, store, runId);
      expect(await snapshot(runId), `seed ${String(seed)}`).toEqual(incremental);
    }
  });
});
