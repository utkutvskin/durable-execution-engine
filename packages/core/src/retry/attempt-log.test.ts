import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import { createResultRecorder } from "../idempotency/recorder.js";
import { refreshProjection } from "../run/projection-store.js";
import { createAttemptLog, type AttemptLog } from "./attempt-log.js";

describe("attempt log", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let log: AttemptLog;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    log = createAttemptLog(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'flow') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [
      { type: "run_started", workflowType: "flow", input: {} },
      { type: "step_scheduled", stepId: "s1", stepType: "work", input: {} },
    ]);
  });

  const failure = {
    stepId: "s1",
    attempt: 1,
    error: { name: "Error", message: "late" },
    retryAt: null,
  };

  async function eventTypes(): Promise<string[]> {
    return (await store.read(runId)).map((event) => event.event.type);
  }

  it("records the first failed attempt once", async () => {
    expect(await log.recordFailure({ runId, ...failure })).toBe(true);
    expect(await log.recordFailure({ runId, ...failure })).toBe(false);
    expect((await eventTypes()).filter((type) => type === "step_attempt_failed")).toHaveLength(1);
  });

  it("writes nothing when the step already has its terminal result", async () => {
    await createResultRecorder(database.pool).recordStepResult({
      runId,
      stepId: "s1",
      attemptKey: "attempt-2",
      outcome: { status: "completed", result: 1 },
    });
    expect(await log.recordFailure({ runId, ...failure })).toBe(false);
    expect(await eventTypes()).not.toContain("step_attempt_failed");
    const rows = await database.pool.query("select 1 from step_attempts where run_id = $1", [
      runId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("writes nothing to a run that already completed", async () => {
    await store.append(runId, 2, [{ type: "run_completed", result: 1 }]);
    await refreshProjection(database.pool, store, runId);
    expect(await log.recordFailure({ runId, ...failure })).toBe(false);
    expect(await eventTypes()).toEqual(["run_started", "step_scheduled", "run_completed"]);
  });
});
