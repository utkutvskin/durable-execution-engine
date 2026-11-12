import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore, type EventStore } from "./event-store.ts";
import {
  CURRENT_EVENT_VERSION,
  KNOWN_EVENT_TYPES,
  UnsupportedEventError,
  readVersionedEvent,
} from "./event-version.ts";
import { workflowEventSchema } from "./events.ts";

describe("readVersionedEvent", () => {
  it("knows every event type of the schema", () => {
    expect([...KNOWN_EVENT_TYPES].sort()).toEqual(
      workflowEventSchema.options.map((option) => option.shape.type.value).sort(),
    );
    expect(KNOWN_EVENT_TYPES).toContain("run_started");
  });

  it("drops fields a newer version added to a known event type", () => {
    const event = readVersionedEvent(
      { type: "step_scheduled", stepId: "step-1", stepType: "charge", input: 1, priority: "high" },
      CURRENT_EVENT_VERSION + 1,
    );
    expect(event).toEqual({
      type: "step_scheduled",
      stepId: "step-1",
      stepType: "charge",
      input: 1,
    });
  });

  it("refuses an unknown event type of a newer version with UnsupportedEventError", () => {
    expect(() =>
      readVersionedEvent({ type: "step_paused", stepId: "step-1" }, CURRENT_EVENT_VERSION + 1),
    ).toThrow(UnsupportedEventError);
    try {
      readVersionedEvent({ type: "step_paused" }, CURRENT_EVENT_VERSION + 1);
    } catch (error) {
      expect(error).toMatchObject({ eventType: "step_paused", version: CURRENT_EVENT_VERSION + 1 });
      expect((error as Error).message).toContain("upgrade the engine");
    }
  });

  it("treats an unknown event type of the current version as a schema error", () => {
    expect(() => readVersionedEvent({ type: "step_paused" }, CURRENT_EVENT_VERSION)).toThrow(
      ZodError,
    );
  });

  it("still requires the fields this build knows on a newer event", () => {
    expect(() =>
      readVersionedEvent({ type: "step_completed", result: 1 }, CURRENT_EVENT_VERSION + 1),
    ).toThrow(ZodError);
  });

  it("rejects a version that is not a whole number from 1", () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => readVersionedEvent({ type: "run_completed", result: 1 }, version)).toThrow(
        UnsupportedEventError,
      );
    }
  });
});

describe("event versions in the event store", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let runId: string;

  beforeEach(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('acme') returning id",
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
  });

  afterEach(async () => {
    await database.close();
  });

  async function insertRaw(sequence: number, payload: unknown, version: number): Promise<void> {
    await database.pool.query(
      `insert into run_events (run_id, sequence_number, event_type, payload, event_version)
       values ($1, $2, $3, $4::jsonb, $5)`,
      [runId, sequence, (payload as { type: string }).type, JSON.stringify(payload), version],
    );
  }

  it("writes and reads back the current version", async () => {
    const appended = await store.append(runId, 0, [
      { type: "run_started", workflowType: "ship-order", input: {} },
    ]);
    expect(appended[0]?.version).toBe(CURRENT_EVENT_VERSION);
    const stored = await database.pool.query<{ event_version: number }>(
      "select event_version from run_events where run_id = $1",
      [runId],
    );
    expect(stored.rows).toEqual([{ event_version: CURRENT_EVENT_VERSION }]);
    expect((await store.read(runId))[0]?.version).toBe(CURRENT_EVENT_VERSION);
  });

  it("reads a history holding an event of a newer version with an added field", async () => {
    await insertRaw(1, { type: "run_started", workflowType: "ship-order", input: {} }, 1);
    await insertRaw(2, { type: "run_completed", result: 7, closedBy: "worker-a" }, 2);
    const history = await store.read(runId);
    expect(history.map((stored) => [stored.version, stored.event])).toEqual([
      [1, { type: "run_started", workflowType: "ship-order", input: {} }],
      [2, { type: "run_completed", result: 7 }],
    ]);
  });

  it("fails a read that meets an unknown event type of a newer version", async () => {
    await insertRaw(1, { type: "run_started", workflowType: "ship-order", input: {} }, 1);
    await insertRaw(2, { type: "run_paused" }, 2);
    await expect(store.read(runId)).rejects.toBeInstanceOf(UnsupportedEventError);
  });

  it("refuses a stored version below 1", async () => {
    await expect(
      insertRaw(1, { type: "run_started", workflowType: "ship-order", input: {} }, 0),
    ).rejects.toThrow(/run_events_event_version_check/);
  });
});
