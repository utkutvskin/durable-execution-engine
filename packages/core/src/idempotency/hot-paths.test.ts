import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCountingPool, type CountingPool } from "../db/statement-counter.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { jsonCodec } from "../event-store/codec.ts";
import { ConcurrencyError } from "../event-store/errors.ts";
import { createPostgresEventStore } from "../event-store/event-store.ts";
import { createTaskQueue } from "../queue/task-queue.ts";
import { refreshProjection } from "../run/projection-store.ts";
import { insertRunOnClient } from "../run/insert-run.ts";
import { createResultRecorder } from "./recorder.ts";

describe("hot paths in one statement", () => {
  let database: IsolatedSchema;
  let counting: CountingPool;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    counting = createCountingPool(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    counting.reset();
  });

  async function createRun(): Promise<string> {
    const client = await database.pool.connect();
    try {
      const runId = await insertRunOnClient(client, jsonCodec, {
        namespaceId,
        workflowType: "ship-order",
        input: { order: 7 },
        queueName: "default",
      });
      return runId ?? "";
    } finally {
      client.release();
    }
  }

  async function leaseStepTask(runId: string): Promise<{ id: string; leaseToken: string }> {
    const queue = createTaskQueue(database.pool);
    await database.pool.query("update tasks set state = 'COMPLETED' where run_id = $1", [runId]);
    await queue.enqueue({ namespaceId, runId, queueName: "steps", taskType: "STEP_TASK" });
    const [task] = await queue.dequeue({ queueName: "steps", visibilityTimeoutMs: 30_000 });
    if (task === undefined) {
      throw new Error("no step task was leased");
    }
    return { id: task.id, leaseToken: task.leaseToken };
  }

  async function taskStates(runId: string): Promise<{ task_type: string; state: string }[]> {
    const result = await database.pool.query<{ task_type: string; state: string }>(
      "select task_type, state from tasks where run_id = $1 order by created_at, id",
      [runId],
    );
    return result.rows;
  }

  it("starts a run with its run_started event and first workflow task in one statement", async () => {
    const client = await counting.pool.connect();
    let runId: string | undefined;
    try {
      runId = await insertRunOnClient(client, jsonCodec, {
        namespaceId,
        workflowType: "ship-order",
        input: { order: 1 },
        queueName: "default",
        priority: 5,
      });
    } finally {
      client.release();
    }

    expect(counting.statements).toHaveLength(1);
    const history = await createPostgresEventStore(database.pool).read(runId ?? "");
    expect(history.map((stored) => stored.event)).toEqual([
      { type: "run_started", workflowType: "ship-order", input: { order: 1 } },
    ]);
    const tasks = await database.pool.query<{ task_type: string; priority: number }>(
      "select task_type, priority from tasks where run_id = $1",
      [runId],
    );
    expect(tasks.rows).toEqual([{ task_type: "WORKFLOW_TASK", priority: 5 }]);
  });

  it("records a step result, enqueues the next workflow task and acks the step task in one statement", async () => {
    const runId = await createRun();
    const task = await leaseStepTask(runId);
    counting.reset();

    const completed = await createResultRecorder(counting.pool).completeStepTask(
      { id: task.id, runId, leaseToken: task.leaseToken },
      {
        result: {
          stepId: "charge-card",
          attemptKey: "attempt-1",
          outcome: { status: "completed", result: { charged: 42 } },
        },
        followUpQueue: "default",
        followUpPayload: { reason: "step_completed" },
      },
    );

    expect(counting.statements).toHaveLength(1);
    expect(completed).toEqual({
      recorded: true,
      outcome: { status: "completed", result: { charged: 42 } },
      acked: true,
    });
    const history = await createPostgresEventStore(database.pool).read(runId);
    expect(history.at(-1)?.event).toEqual({
      type: "step_completed",
      stepId: "charge-card",
      result: { charged: 42 },
    });
    expect(await taskStates(runId)).toEqual([
      { task_type: "WORKFLOW_TASK", state: "COMPLETED" },
      { task_type: "STEP_TASK", state: "COMPLETED" },
      { task_type: "WORKFLOW_TASK", state: "PENDING" },
    ]);
  });

  it("gives a redelivered step the stored outcome and keeps a recorded result when the lease is gone", async () => {
    const runId = await createRun();
    const task = await leaseStepTask(runId);
    const recorder = createResultRecorder(database.pool);
    await recorder.recordStepResult({
      runId,
      stepId: "charge-card",
      attemptKey: "attempt-1",
      outcome: { status: "completed", result: "first" },
    });

    const redelivered = await recorder.completeStepTask(
      { id: task.id, runId, leaseToken: "00000000-0000-4000-8000-000000000000" },
      {
        result: {
          stepId: "charge-card",
          attemptKey: "attempt-2",
          outcome: { status: "completed", result: "second" },
        },
      },
    );

    expect(redelivered).toEqual({
      recorded: false,
      outcome: { status: "completed", result: "first" },
      acked: false,
    });
    const results = await database.pool.query<{ result: unknown }>(
      "select result from step_results where run_id = $1",
      [runId],
    );
    expect(results.rows).toEqual([{ result: "first" }]);
  });

  it("discards a step result of a closed run, enqueues nothing for it and still acks the task", async () => {
    const runId = await createRun();
    const task = await leaseStepTask(runId);
    await database.pool.query("update workflow_runs set status = 'CANCELLED' where id = $1", [
      runId,
    ]);

    const completed = await createResultRecorder(database.pool).completeStepTask(
      { id: task.id, runId, leaseToken: task.leaseToken },
      {
        result: {
          stepId: "charge-card",
          attemptKey: "attempt-1",
          outcome: { status: "completed", result: 1 },
        },
        followUpQueue: "default",
      },
    );

    expect(completed.recorded).toBe(false);
    expect(completed.acked).toBe(true);
    expect(await taskStates(runId)).toEqual([
      { task_type: "WORKFLOW_TASK", state: "COMPLETED" },
      { task_type: "STEP_TASK", state: "COMPLETED" },
    ]);
    const results = await database.pool.query("select 1 from step_results where run_id = $1", [
      runId,
    ]);
    expect(results.rowCount).toBe(0);
  });

  it("records a decision without side effects in one statement and rejects a stale one with the current sequence", async () => {
    const runId = await createRun();
    const recorder = createResultRecorder(counting.pool);

    const recorded = await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "task-1",
      expectedSeq: 1,
      events: [{ type: "step_scheduled", stepId: "a", stepType: "charge", input: null }],
    });
    expect(counting.statements).toHaveLength(1);
    expect(recorded).toEqual({ recorded: true, firstSequenceNumber: 2, lastSequenceNumber: 2 });

    const stale = recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "task-2",
      expectedSeq: 1,
      events: [{ type: "step_scheduled", stepId: "b", stepType: "charge", input: null }],
    });
    await expect(stale).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(stale).rejects.toMatchObject({ expectedSeq: 1, actualSeq: 2 });
    const duplicate = await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "task-1",
      expectedSeq: 1,
      events: [{ type: "step_scheduled", stepId: "a", stepType: "charge", input: null }],
    });
    expect(duplicate).toEqual({ recorded: false, firstSequenceNumber: 2, lastSequenceNumber: 2 });
    const history = await createPostgresEventStore(database.pool).read(runId);
    expect(history).toHaveLength(2);
  });

  it("closes a run in four statements: the decision, the projection and the withdrawn tasks", async () => {
    const runId = await createRun();
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
       values ($1, $2, 'default', 'STEP_TASK', '{}', now() + interval '1 hour')`,
      [namespaceId, runId],
    );
    counting.reset();

    await createResultRecorder(counting.pool).recordWorkflowTaskResult({
      runId,
      taskKey: "finish",
      expectedSeq: 1,
      events: [{ type: "run_completed", result: { shipped: true } }],
    });

    expect(counting.statements.map((sql) => sql.split("(")[0]?.trim())).toEqual([
      "begin",
      "select outcome, first_sequence_number, last_sequence_number, traceparent, namespace_id, run_status, run_input, run_result, run_error, run_closed_at, projected_sequence_number, unfolded_sequence_numbers, unfolded_payloads, unfolded_versions, unfolded_created_at from record_workflow_task",
      "select parent_linked, open_children from close_run",
      "commit",
    ]);
    const run = await database.pool.query<{
      status: string;
      input: unknown;
      result: unknown;
      last_sequence_number: string;
      closed_at: Date | null;
    }>(
      "select status, input, result, last_sequence_number, closed_at from workflow_runs where id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "COMPLETED",
      input: { order: 7 },
      result: { shipped: true },
      last_sequence_number: "2",
    });
    expect(run.rows[0]?.closed_at).toBeInstanceOf(Date);
    const open = await database.pool.query(
      "select 1 from tasks where run_id = $1 and state = 'PENDING'",
      [runId],
    );
    expect(open.rowCount).toBe(0);
  });

  it("refreshes a projection that is already up to date with one read and no write", async () => {
    const runId = await createRun();
    const store = createPostgresEventStore(database.pool);
    await refreshProjection(database.pool, store, runId);
    counting.reset();

    const projection = await refreshProjection(counting.pool, store, runId);

    expect(counting.statements).toHaveLength(1);
    expect(projection).toMatchObject({ state: "RUNNING", input: { order: 7 } });
  });
});
