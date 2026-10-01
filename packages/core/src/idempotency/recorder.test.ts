import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import type { Codec } from "../event-store/codec.js";
import { jsonCodec } from "../event-store/codec.js";
import { ConcurrencyError } from "../event-store/errors.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import { createResultRecorder, type ResultRecorder } from "./recorder.js";

describe("result recorder", () => {
  let database: IsolatedSchema;
  let runId: string;
  let store: EventStore;
  let recorder: ResultRecorder;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
    store = createPostgresEventStore(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from step_results");
    await database.pool.query("delete from run_events");
    recorder = createResultRecorder(database.pool);
  });

  async function countRows(table: string): Promise<number> {
    const result = await database.pool.query<{ n: string }>(`select count(*) as n from ${table}`);
    return Number(result.rows[0]?.n);
  }

  async function deliverStep(executions: { count: number }, attemptKey = "attempt-1") {
    executions.count += 1;
    return recorder.recordStepResult({
      runId,
      stepId: "charge-card",
      attemptKey,
      outcome: { status: "completed", result: { charged: executions.count } },
    });
  }

  it("writes exactly one result and one event when the same step task is delivered 5 times", async () => {
    const executions = { count: 0 };
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => deliverStep(executions)));

    expect(executions.count).toBe(5);
    expect(outcomes.filter((outcome) => outcome.recorded)).toHaveLength(1);
    expect(await countRows("step_results")).toBe(1);
    const history = await store.read(runId);
    expect(history).toHaveLength(1);
    expect(history[0]?.event.type).toBe("step_completed");
  });

  it("hands every redelivery the first delivery's stored outcome", async () => {
    const first = await deliverStep({ count: 0 });
    const second = await recorder.recordStepResult({
      runId,
      stepId: "charge-card",
      attemptKey: "attempt-1",
      outcome: { status: "completed", result: { charged: 99 } },
    });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.outcome).toEqual({ status: "completed", result: { charged: 1 } });
  });

  it("records a failed step as step_failed and returns the stored error on redelivery", async () => {
    const error = { name: "CardDeclined", message: "declined", stack: "stack-trace" };
    const input = {
      runId,
      stepId: "charge-card",
      attemptKey: "attempt-1",
      outcome: { status: "failed" as const, error },
    };
    await recorder.recordStepResult(input);
    const again = await recorder.recordStepResult(input);

    expect(again).toEqual({ recorded: false, outcome: { status: "failed", error } });
    const history = await store.read(runId);
    expect(history.map((stored) => stored.event.type)).toEqual(["step_failed"]);
  });

  it("treats a different attempt key as a separate result", async () => {
    await deliverStep({ count: 0 }, "attempt-1");
    const retry = await deliverStep({ count: 1 }, "attempt-2");

    expect(retry.recorded).toBe(true);
    expect(await countRows("step_results")).toBe(2);
    expect(await store.read(runId)).toHaveLength(2);
  });

  it("lets two different steps finishing at once both append without a sequence clash", async () => {
    await Promise.all(
      ["a", "b", "c", "d"].map((stepId) =>
        recorder.recordStepResult({
          runId,
          stepId,
          attemptKey: "attempt-1",
          outcome: { status: "completed", result: stepId },
        }),
      ),
    );

    const history = await store.read(runId);
    expect(history.map((stored) => stored.sequenceNumber)).toEqual([1, 2, 3, 4]);
  });

  it("leaves no partial record when the transaction is cut off before the event is written", async () => {
    const failingCodec: Codec = {
      encode: () => {
        throw new Error("connection lost mid-write");
      },
      decode: (text: string) => jsonCodec.decode(text),
    };
    const broken = createResultRecorder(database.pool, failingCodec);

    await expect(
      broken.recordStepResult({
        runId,
        stepId: "charge-card",
        attemptKey: "attempt-1",
        outcome: { status: "completed", result: 1 },
      }),
    ).rejects.toThrow("connection lost mid-write");

    expect(await countRows("step_results")).toBe(0);
    expect(await countRows("run_events")).toBe(0);
  });

  it("records a workflow task decision once however often the task is delivered", async () => {
    const decision = {
      runId,
      taskKey: "wf-task-1",
      expectedSeq: 0,
      events: [
        { type: "step_completed" as const, stepId: "a", result: 1 },
        { type: "step_completed" as const, stepId: "b", result: 2 },
      ],
    };
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => recorder.recordWorkflowTaskResult(decision)),
    );

    expect(outcomes.filter((outcome) => outcome.recorded)).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.lastSequenceNumber === 2)).toBe(true);
    expect(await store.read(runId)).toHaveLength(2);
    expect(await countRows("workflow_task_results")).toBe(1);
  });

  it("rejects a new workflow task with a stale expected sequence and records nothing", async () => {
    await store.append(runId, 0, [{ type: "step_completed", stepId: "a", result: 1 }]);

    await expect(
      recorder.recordWorkflowTaskResult({
        runId,
        taskKey: "wf-task-2",
        expectedSeq: 0,
        events: [{ type: "step_completed", stepId: "b", result: 2 }],
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    expect(await countRows("workflow_task_results")).toBe(0);
    expect(await store.read(runId)).toHaveLength(1);
  });

  it("rolls back the workflow task marker when appending its events fails", async () => {
    const failingCodec: Codec = {
      encode: () => {
        throw new Error("write cut off");
      },
      decode: (text: string) => jsonCodec.decode(text),
    };
    const broken = createResultRecorder(database.pool, failingCodec);

    await expect(
      broken.recordWorkflowTaskResult({
        runId,
        taskKey: "wf-task-3",
        expectedSeq: 0,
        events: [{ type: "step_completed", stepId: "a", result: 1 }],
      }),
    ).rejects.toThrow("write cut off");

    expect(await countRows("workflow_task_results")).toBe(0);
    expect(await countRows("run_events")).toBe(0);
  });

  it("refuses a duplicate (run, step, attempt key) at the database level", async () => {
    await deliverStep({ count: 0 });

    await expect(
      database.pool.query(
        "insert into step_results (run_id, step_id, attempt_key) values ($1, 'charge-card', 'attempt-1')",
        [runId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
