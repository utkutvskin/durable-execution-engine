import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import {
  createRunInteractions,
  RunNotFoundError,
  RunNotOpenError,
} from "../signals/signal-service.js";
import type { WorkflowCommand } from "../workflow/commands.js";
import { runDecisionLoop } from "../workflow/decision-loop.js";
import { defineWorkflow } from "../workflow/define-workflow.js";
import type { ClockSource, RandomSource } from "../workflow/sources.js";
import { createWorkflowRegistry } from "../workflow/workflow-registry.js";
import { createRunControl, RunAlreadyClosedError, type RunControl } from "./run-control.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const saga = defineWorkflow("trip", async (ctx) => {
  await ctx.step("book-flight", {});
  ctx.onCancel(async (compensation) => {
    await compensation.step("refund-flight", {});
  });
  await ctx.step("book-hotel", {});
  ctx.onCancel(async (compensation) => {
    await compensation.step("cancel-hotel", {});
  });
  await ctx.waitForSignal("confirm");
  return "booked";
});

function toEvent(command: WorkflowCommand): WorkflowEvent {
  switch (command.type) {
    case "schedule_step":
      return {
        type: "step_scheduled",
        stepId: command.stepId,
        stepType: command.stepType,
        input: command.input,
      };
    case "start_timer":
      return { type: "timer_started", timerId: command.timerId, fireAt: command.fireAt };
    case "complete_run":
      return { type: "run_completed", result: command.result };
    case "fail_run":
      return { type: "run_failed", error: command.error };
    case "cancel_run":
      return command.reason === undefined
        ? { type: "run_cancelled" }
        : { type: "run_cancelled", reason: command.reason };
  }
}

describe("run control", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let control: RunControl;
  let recorder: ResultRecorder;
  let runId: string;
  let taskCounter: number;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    control = createRunControl(database.pool, { queueName: "default" });
    recorder = createResultRecorder(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    taskCounter = 0;
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from step_results");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from namespaces");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'trip') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "trip", input: {} }]);
  });

  async function history(): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function status(): Promise<string> {
    const row = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0]?.status ?? "";
  }

  async function decide() {
    const events = await history();
    const decision = await runDecisionLoop(saga.handler, {}, events, sources);
    taskCounter += 1;
    const recorded = await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `task-${String(taskCounter)}`,
      expectedSeq: events.length,
      events: decision.commands.map(toEvent),
    });
    return { decision, recorded };
  }

  async function completeScheduledSteps(): Promise<string[]> {
    const events = await history();
    const finished = new Set(
      events.flatMap((event) => (event.type === "step_completed" ? [event.stepId] : [])),
    );
    const completed: string[] = [];
    for (const event of events) {
      if (event.type === "step_scheduled" && !finished.has(event.stepId)) {
        await recorder.recordStepResult({
          runId,
          stepId: event.stepId,
          attemptKey: "1",
          outcome: { status: "completed", result: null },
        });
        completed.push(event.stepType);
      }
    }
    return completed;
  }

  async function runUntilBooked(): Promise<void> {
    await decide();
    await completeScheduledSteps();
    await decide();
    await completeScheduledSteps();
    await decide();
  }

  async function scheduledStepTypes(): Promise<string[]> {
    return (await history()).flatMap((event) =>
      event.type === "step_scheduled" ? [event.stepType] : [],
    );
  }

  it("records a cancellation request and one workflow task without closing the run", async () => {
    const receipt = await control.cancelRun(runId, "customer");

    expect(receipt).toEqual({ requested: true, sequenceNumber: 2 });
    expect((await history())[1]).toEqual({ type: "cancel_requested", reason: "customer" });
    const tasks = await database.pool.query<{ task_type: string; payload: { reason: string } }>(
      "select task_type, payload from tasks where run_id = $1",
      [runId],
    );
    expect(tasks.rows).toEqual([{ task_type: "WORKFLOW_TASK", payload: { reason: "cancel" } }]);
    expect(await status()).toBe("RUNNING");
  });

  it("writes nothing when cancellation was already requested", async () => {
    await control.cancelRun(runId);
    const again = await control.cancelRun(runId);

    expect(again).toEqual({ requested: false, sequenceNumber: 2 });
    expect(await history()).toHaveLength(2);
    const tasks = await database.pool.query("select 1 from tasks where run_id = $1", [runId]);
    expect(tasks.rowCount).toBe(1);
  });

  it("runs the compensations in reverse order and closes the run as CANCELLED", async () => {
    await runUntilBooked();
    await control.cancelRun(runId, "customer");

    const first = await decide();
    expect(first.decision.outcome).toBe("suspended");
    await completeScheduledSteps();
    const second = await decide();
    expect(second.decision.outcome).toBe("suspended");
    await completeScheduledSteps();
    const last = await decide();

    expect(last.decision.outcome).toBe("cancelled");
    expect(await scheduledStepTypes()).toEqual([
      "book-flight",
      "book-hotel",
      "cancel-hotel",
      "refund-flight",
    ]);
    expect(await status()).toBe("CANCELLED");
    expect((await history()).at(-1)).toEqual({ type: "run_cancelled", reason: "customer" });
  });

  it("withdraws the waiting tasks of a run once it is cancelled", async () => {
    await runUntilBooked();
    await control.cancelRun(runId);
    await decide();
    await completeScheduledSteps();
    await decide();
    await completeScheduledSteps();
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type)
       select namespace_id, id, 'default', 'STEP_TASK' from workflow_runs where id = $1`,
      [runId],
    );
    await decide();

    const open = await database.pool.query(
      "select 1 from tasks where run_id = $1 and state in ('PENDING', 'LEASED')",
      [runId],
    );
    expect(open.rowCount).toBe(0);
  });

  it("terminates a run at once without running any compensation", async () => {
    await runUntilBooked();

    const receipt = await control.terminateRun(runId, "operator");

    expect(await status()).toBe("TERMINATED");
    expect((await history())[receipt.sequenceNumber - 1]).toEqual({
      type: "run_terminated",
      reason: "operator",
    });
    expect(await scheduledStepTypes()).toEqual(["book-flight", "book-hotel"]);
  });

  it("discards a decision and a step result that arrive after termination", async () => {
    await decide();
    await control.terminateRun(runId);
    const lengthAtTermination = (await history()).length;

    const late = await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "late-decision",
      expectedSeq: lengthAtTermination,
      events: [{ type: "step_scheduled", stepId: "step-9", stepType: "late", input: {} }],
    });
    const lateStep = await recorder.recordStepResult({
      runId,
      stepId: "step-1",
      attemptKey: "1",
      outcome: { status: "completed", result: null },
    });

    expect(late.recorded).toBe(false);
    expect(lateStep.recorded).toBe(false);
    expect(await history()).toHaveLength(lengthAtTermination);
  });

  it("terminates a run whose graceful cancellation is still pending", async () => {
    await runUntilBooked();
    await control.cancelRun(runId);

    await control.terminateRun(runId);

    expect(await status()).toBe("TERMINATED");
    expect(await scheduledStepTypes()).toEqual(["book-flight", "book-hotel"]);
  });

  it("rejects cancel and terminate on a closed run and on a missing run", async () => {
    await control.terminateRun(runId);

    await expect(control.cancelRun(runId)).rejects.toBeInstanceOf(RunAlreadyClosedError);
    await expect(control.terminateRun(runId)).rejects.toBeInstanceOf(RunAlreadyClosedError);
    await expect(control.cancelRun("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
    expect(await history()).toHaveLength(2);
  });

  it("stops accepting signals once a run is terminated", async () => {
    const workflows = createWorkflowRegistry();
    workflows.register(saga);
    const interactions = createRunInteractions(database.pool, {
      queueName: "default",
      workflows,
      ...sources,
    });

    await control.terminateRun(runId);

    await expect(interactions.signalRun(runId, "confirm")).rejects.toBeInstanceOf(RunNotOpenError);
  });

  it("records ten concurrent cancellation requests once", async () => {
    await Promise.all(Array.from({ length: 10 }, () => control.cancelRun(runId)));

    const requests = (await history()).filter((event) => event.type === "cancel_requested");
    expect(requests).toHaveLength(1);
  });
});
