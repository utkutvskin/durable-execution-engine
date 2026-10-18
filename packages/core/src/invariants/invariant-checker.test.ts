import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createTaskQueue } from "../queue/task-queue.js";
import { refreshProjection } from "../run/projection-store.js";
import { createResultRecorder } from "../idempotency/recorder.js";
import { createInvariantChecker, type InvariantChecker } from "./invariant-checker.js";

describe("invariant checker", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let checker: InvariantChecker;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    checker = createInvariantChecker(database.pool, store);
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  async function createRun(events: readonly WorkflowEvent[] = []): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'double') returning id",
      [namespaceId],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [
      { type: "run_started", workflowType: "double", input: {} },
      ...events,
    ]);
    return runId;
  }

  async function enqueueStepTask(runId: string, stepId: string): Promise<string> {
    return createTaskQueue(database.pool).enqueue({
      namespaceId,
      runId,
      queueName: "default/steps",
      taskType: "STEP_TASK",
      payload: { stepId },
    });
  }

  async function violationsOf(runId: string, expectedTaskIds: string[] = []) {
    const report = await checker.check({ runIds: [runId], expectedTaskIds });
    return report.violations;
  }

  it("reports nothing for a run that completed through the recorder", async () => {
    const runId = await createRun([
      { type: "step_scheduled", stepId: "s1", stepType: "double", input: 1 },
    ]);
    const taskId = await enqueueStepTask(runId, "s1");
    const recorder = createResultRecorder(database.pool);
    await recorder.recordStepResult({
      runId,
      stepId: "s1",
      attemptKey: "s1#1",
      outcome: { status: "completed", result: 2 },
    });
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "finish",
      expectedSeq: 3,
      events: [{ type: "run_completed", result: 2 }],
    });
    await database.pool.query("update tasks set state = 'COMPLETED' where id = $1", [taskId]);
    await refreshProjection(database.pool, store, runId);

    const report = await checker.check({ runIds: [runId], expectedTaskIds: [taskId] });

    expect(report.violations).toEqual([]);
    expect(report.runsChecked).toBe(1);
    expect(report.tasksChecked).toBe(1);
  });

  it("flags a running run that has no open task, timer, dead letter or child", async () => {
    const runId = await createRun();
    const violations = await violationsOf(runId);
    expect(violations.map((entry) => entry.invariant)).toEqual(["run-terminal-or-advancing"]);
  });

  it("accepts a running run that waits on a pending timer", async () => {
    const runId = await createRun();
    await database.pool.query(
      "insert into timers (run_id, timer_id, fire_at) values ($1, 't1', now())",
      [runId],
    );
    expect(await violationsOf(runId)).toEqual([]);
  });

  it("flags an expected task that no longer exists", async () => {
    const runId = await createRun();
    const taskId = await enqueueStepTask(runId, "s1");
    await database.pool.query("delete from tasks where id = $1", [taskId]);
    const violations = await violationsOf(runId, [taskId]);
    expect(violations.some((entry) => entry.invariant === "task-not-lost")).toBe(true);
    expect(violations.find((entry) => entry.invariant === "task-not-lost")?.taskId).toBe(taskId);
  });

  it("flags a leased task without a lease token", async () => {
    const runId = await createRun();
    const taskId = await enqueueStepTask(runId, "s1");
    await database.pool.query("update tasks set state = 'LEASED' where id = $1", [taskId]);
    const violations = await violationsOf(runId);
    expect(violations.map((entry) => entry.detail)).toContain(
      "task is LEASED without a lease token",
    );
  });

  it("flags an acked step task whose step recorded nothing", async () => {
    const runId = await createRun([
      { type: "step_scheduled", stepId: "s1", stepType: "double", input: 1 },
    ]);
    const taskId = await enqueueStepTask(runId, "s1");
    await database.pool.query("update tasks set state = 'COMPLETED' where id = $1", [taskId]);
    const violations = await violationsOf(runId);
    expect(violations.filter((entry) => entry.invariant === "task-not-lost")).toHaveLength(1);
  });

  it("flags a step with two terminal events", async () => {
    const runId = await createRun([
      { type: "step_scheduled", stepId: "s1", stepType: "double", input: 1 },
      { type: "step_completed", stepId: "s1", result: 2 },
      { type: "step_completed", stepId: "s1", result: 2 },
    ]);
    await enqueueStepTask(runId, "s1");
    const violations = await violationsOf(runId);
    expect(violations.map((entry) => entry.invariant)).toContain("step-result-written-once");
  });

  it("flags a stored step result that has no event", async () => {
    const runId = await createRun();
    await enqueueStepTask(runId, "s1");
    await database.pool.query(
      "insert into step_results (run_id, step_id, attempt_key, result) values ($1, 's1', 'a', '1')",
      [runId],
    );
    const violations = await violationsOf(runId);
    expect(violations.map((entry) => entry.detail)).toContain(
      'step "s1" has a stored result but no terminal event',
    );
  });

  it("flags a projection that is ahead of the log", async () => {
    const runId = await createRun();
    await enqueueStepTask(runId, "s1");
    await database.pool.query("update workflow_runs set last_sequence_number = 9 where id = $1", [
      runId,
    ]);
    const violations = await violationsOf(runId);
    expect(violations.map((entry) => entry.invariant)).toContain("projection-consistent");
  });

  it("flags a projection that still shows a run the log has closed", async () => {
    const runId = await createRun([{ type: "run_completed", result: 1 }]);
    const violations = await violationsOf(runId);
    expect(violations.map((entry) => entry.detail)).toContain(
      "the log closed the run as COMPLETED but the row is still RUNNING",
    );
  });

  it("flags a projection whose status disagrees with its own sequence number", async () => {
    const runId = await createRun([{ type: "run_completed", result: 1 }]);
    await refreshProjection(database.pool, store, runId);
    await database.pool.query("update workflow_runs set status = 'FAILED' where id = $1", [runId]);
    const violations = await violationsOf(runId);
    expect(violations.some((entry) => entry.invariant === "projection-consistent")).toBe(true);
  });

  it("flags a timer with two timer_fired events and one that fired early", async () => {
    const runId = await createRun([
      { type: "timer_started", timerId: "t1", fireAt: "2030-01-01T00:00:00.000Z" },
      { type: "timer_fired", timerId: "t1" },
      { type: "timer_fired", timerId: "t1" },
    ]);
    await enqueueStepTask(runId, "s1");
    await database.pool.query(
      `insert into timers (run_id, timer_id, fire_at, state, fired_at)
       values ($1, 't1', now() + interval '1 hour', 'FIRED', now())`,
      [runId],
    );
    const details = (await violationsOf(runId)).map((entry) => entry.detail);
    expect(details).toContain('timer "t1" has 2 timer_fired events');
    expect(details).toContain('timer "t1" fired before it was due');
  });

  it("limits the check to the given runs", async () => {
    const stalled = await createRun();
    const other = await createRun();
    await enqueueStepTask(other, "s1");
    const report = await checker.check({ runIds: [other] });
    expect(report.runsChecked).toBe(1);
    expect(report.violations.every((entry) => entry.runId !== stalled)).toBe(true);
  });
});
