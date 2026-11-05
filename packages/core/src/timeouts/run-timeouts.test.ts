import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import { createTimerScheduler } from "../timers/timer-scheduler.js";
import { commandToEvent } from "../workflow/command-events.js";
import { runDecisionLoop } from "../workflow/decision-loop.js";
import { defineWorkflow } from "../workflow/define-workflow.js";
import { applyRunTimeoutsOnClient, validateTimeoutMs } from "./run-timeouts.js";

const QUEUE = "default";
const START = new Date("2026-03-01T10:00:00.000Z");
const HOUR = 3_600_000;

describe("run timeouts", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let namespaceId: string;
  let now = START;
  let taskCounter = 0;
  const clock = { now: () => now };
  const sources = {
    clock,
    random: { random: () => 0.5, uuid: () => "fixed-uuid" },
  };

  const parent = defineWorkflow("parent", async (ctx) => {
    try {
      return await ctx.executeChild<string>("slow", {}, { runTimeoutMs: HOUR });
    } catch (error) {
      return `child ended: ${(error as Error).name}`;
    }
  });

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: QUEUE, clock });
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from timers");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from step_results");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    now = START;
    taskCounter = 0;
  });

  function timers() {
    return createTimerScheduler(database.pool, { queueName: QUEUE, clock });
  }

  async function startRun(
    workflowType: string,
    limits: { runTimeoutMs?: number; executionTimeoutMs?: number } = {},
  ): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, queue_name) values ($1, $2, $3) returning id",
      [namespaceId, workflowType, QUEUE],
    );
    const runId = run.rows[0]?.id ?? "";
    const client = await database.pool.connect();
    try {
      await applyRunTimeoutsOnClient(client, runId, now, limits);
    } finally {
      client.release();
    }
    await store.append(runId, 0, [{ type: "run_started", workflowType, input: {} }]);
    return runId;
  }

  async function history(runId: string): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function status(runId: string): Promise<string> {
    const row = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0]?.status ?? "";
  }

  async function decideParent(runId: string): Promise<void> {
    const events = await history(runId);
    const decision = await runDecisionLoop(parent.handler, {}, events, sources);
    taskCounter += 1;
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `task-${String(taskCounter)}`,
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    });
  }

  async function childOf(parentRunId: string): Promise<string> {
    const row = await database.pool.query<{ id: string }>(
      "select id from workflow_runs where parent_run_id = $1",
      [parentRunId],
    );
    return row.rows[0]?.id ?? "";
  }

  it("ends a child with a one hour timeout as TIMED_OUT on a fake clock and tells its parent", async () => {
    const parentId = await startRun("parent");
    await decideParent(parentId);
    const childId = await childOf(parentId);

    now = new Date(START.getTime() + HOUR - 1);
    expect((await timers().tick()).fired).toHaveLength(0);
    expect(await status(childId)).toBe("RUNNING");

    now = new Date(START.getTime() + HOUR);
    const report = await timers().tick();

    expect(report.fired.map((timer) => timer.timerId)).toEqual(["run-timeout"]);
    expect(await status(childId)).toBe("TIMED_OUT");
    expect((await history(childId)).at(-1)).toEqual({ type: "run_timed_out", kind: "run" });
    expect((await history(parentId)).at(-1)).toMatchObject({
      type: "child_failed",
      error: { name: "TimedOutError" },
    });
  });

  it("lets the parent decide again after its child timed out", async () => {
    const parentId = await startRun("parent");
    await decideParent(parentId);
    now = new Date(START.getTime() + HOUR);
    await timers().tick();

    await decideParent(parentId);

    expect((await history(parentId)).at(-1)).toEqual({
      type: "run_completed",
      result: "child ended: TimedOutError",
    });
    expect(await status(parentId)).toBe("COMPLETED");
  });

  it("withdraws the waiting tasks of a run that timed out", async () => {
    const runId = await startRun("slow", { runTimeoutMs: HOUR });
    await database.pool.query(
      "insert into tasks (namespace_id, run_id, queue_name, task_type) values ($1, $2, $3, 'WORKFLOW_TASK')",
      [namespaceId, runId, QUEUE],
    );

    now = new Date(START.getTime() + HOUR);
    await timers().tick();

    const open = await database.pool.query(
      "select 1 from tasks where run_id = $1 and state = 'PENDING'",
      [runId],
    );
    expect(open.rowCount).toBe(0);
  });

  it("does nothing to a run that closed before its timeout came due", async () => {
    const runId = await startRun("slow", { runTimeoutMs: HOUR });
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "done",
      expectedSeq: 1,
      events: [{ type: "run_completed", result: "fast" }],
    });

    now = new Date(START.getTime() + 2 * HOUR);
    const report = await timers().tick();

    expect(report).toEqual({ fired: [], cancelled: 1 });
    expect(await status(runId)).toBe("COMPLETED");
  });

  it("ends a whole continue-as-new chain at its execution deadline", async () => {
    const first = await startRun("looper", { executionTimeoutMs: 3 * HOUR });
    await recorder.recordWorkflowTaskResult({
      runId: first,
      taskKey: "continue-1",
      expectedSeq: 1,
      events: [{ type: "run_continued_as_new", input: { round: 2 } }],
    });
    const next = await database.pool.query<{ id: string; execution_deadline: Date }>(
      "select id, execution_deadline from workflow_runs where continued_from_run_id = $1",
      [first],
    );
    const nextId = next.rows[0]?.id ?? "";
    expect(next.rows[0]?.execution_deadline).toEqual(new Date(START.getTime() + 3 * HOUR));

    now = new Date(START.getTime() + 3 * HOUR);
    await timers().tick();

    expect(await status(first)).toBe("CONTINUED_AS_NEW");
    expect(await status(nextId)).toBe("TIMED_OUT");
    expect((await history(nextId)).at(-1)).toEqual({ type: "run_timed_out", kind: "execution" });
  });

  it("restarts the run timeout for each run of a chain", async () => {
    const first = await startRun("looper", { runTimeoutMs: HOUR });
    now = new Date(START.getTime() + HOUR / 2);
    await recorder.recordWorkflowTaskResult({
      runId: first,
      taskKey: "continue-1",
      expectedSeq: 1,
      events: [{ type: "run_continued_as_new", input: {} }],
    });
    const next = await database.pool.query<{ id: string }>(
      "select id from workflow_runs where continued_from_run_id = $1",
      [first],
    );
    const nextId = next.rows[0]?.id ?? "";

    now = new Date(START.getTime() + HOUR);
    await timers().tick();
    expect(await status(nextId)).toBe("RUNNING");

    now = new Date(START.getTime() + HOUR / 2 + HOUR);
    await timers().tick();
    expect(await status(nextId)).toBe("TIMED_OUT");
    expect((await history(nextId)).at(-1)).toEqual({ type: "run_timed_out", kind: "run" });
  });

  it("keeps the timeout timers out of the history of workflow timers", async () => {
    const runId = await startRun("slow", { runTimeoutMs: HOUR, executionTimeoutMs: 2 * HOUR });
    const rows = await database.pool.query<{ timer_id: string }>(
      "select timer_id from timers where run_id = $1 order by timer_id",
      [runId],
    );
    expect(rows.rows.map((row) => row.timer_id)).toEqual(["execution-timeout", "run-timeout"]);
    expect(await history(runId)).toHaveLength(1);
  });

  it("rejects a timeout that is zero, negative or not finite", () => {
    expect(() => validateTimeoutMs("runTimeoutMs", 0)).toThrow(RangeError);
    expect(() => validateTimeoutMs("runTimeoutMs", -5)).toThrow(/runTimeoutMs/);
    expect(() => validateTimeoutMs("executionTimeoutMs", Number.NaN)).toThrow(RangeError);
    expect(validateTimeoutMs("runTimeoutMs", undefined)).toBeUndefined();
    expect(validateTimeoutMs("runTimeoutMs", 1500.2)).toBe(1501);
  });
});
