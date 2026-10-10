import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRunControl, type RunControl } from "../cancellation/run-control.js";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import { commandToEvent } from "../workflow/command-events.js";
import { runDecisionLoop, type DecisionResult } from "../workflow/decision-loop.js";
import { defineWorkflow } from "../workflow/define-workflow.js";
import type { ClockSource, RandomSource } from "../workflow/sources.js";
import { findCurrentRun, readRunChain } from "./run-chain.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

interface TickerInput {
  readonly next: number;
  readonly total: number;
  readonly end: number;
}

const PER_RUN = 3;

const ticker = defineWorkflow("ticker", async (ctx, input: TickerInput) => {
  let next = input.next;
  let total = input.total;
  for (let iteration = 0; iteration < PER_RUN && next <= input.end; iteration += 1) {
    total += await ctx.step<number>("add", { value: next });
    next += 1;
  }
  if (next > input.end) {
    return total;
  }
  return ctx.continueAsNew({ next, total, end: input.end });
});

const parentOfTicker = defineWorkflow("parent", async (ctx, input: TickerInput) => {
  const total = await ctx.executeChild<number>("ticker", input);
  return total * 2;
});

describe("continue as new against postgres", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let control: RunControl;
  let namespaceId: string;
  let taskCounter: number;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: "default" });
    control = createRunControl(database.pool, { queueName: "default" });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    taskCounter = 0;
    await database.pool.query("delete from run_snapshots");
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from step_results");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("update workflow_runs set continued_from_run_id = null");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from namespaces");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  async function startRun(workflowType: string, input: unknown): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, input) values ($1, $2, $3::jsonb) returning id",
      [namespaceId, workflowType, JSON.stringify(input)],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType, input }]);
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
       values ($1, $2, 'default', 'WORKFLOW_TASK', '{"reason":"start"}'::jsonb)`,
      [namespaceId, runId],
    );
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

  async function decide(
    runId: string,
    workflow: ReturnType<typeof defineWorkflow<never, unknown>>,
    input: unknown,
  ): Promise<DecisionResult> {
    const events = await history(runId);
    const decision = await runDecisionLoop(workflow.handler, input as never, events, sources);
    taskCounter += 1;
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `task-${String(taskCounter)}`,
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    });
    return decision;
  }

  async function finishSteps(runId: string, decision: DecisionResult): Promise<void> {
    for (const command of decision.commands) {
      if (command.type === "schedule_step") {
        await recorder.recordStepResult({
          runId,
          stepId: command.stepId,
          attemptKey: "1",
          outcome: { status: "completed", result: (command.input as { value: number }).value },
        });
      }
    }
  }

  async function driveRun(runId: string, input: unknown): Promise<DecisionResult> {
    for (;;) {
      const decision = await decide(runId, ticker, input);
      if (decision.outcome !== "suspended") {
        return decision;
      }
      await finishSteps(runId, decision);
    }
  }

  async function driveChain(firstRunId: string, input: TickerInput): Promise<void> {
    let currentInput: TickerInput = input;
    for (;;) {
      const current = await findCurrentRun(database.pool, firstRunId);
      const decision = await driveRun(current?.runId ?? "", currentInput);
      if (decision.outcome !== "continued_as_new") {
        return;
      }
      currentInput = decision.input as TickerInput;
    }
  }

  async function pendingTaskReasons(runId: string): Promise<string[]> {
    const rows = await database.pool.query<{ payload: { reason: string } }>(
      "select payload from tasks where run_id = $1 and state = 'PENDING' order by created_at",
      [runId],
    );
    return rows.rows.map((row) => row.payload.reason);
  }

  it("closes the run as CONTINUED_AS_NEW and starts the next run of the chain", async () => {
    const firstRunId = await startRun("ticker", { next: 1, total: 0, end: 10 });

    const decision = await driveRun(firstRunId, { next: 1, total: 0, end: 10 });

    expect(decision.outcome).toBe("continued_as_new");
    const chain = await readRunChain(database.pool, firstRunId);
    expect(chain.map((run) => [run.chainIndex, run.status])).toEqual([
      [0, "CONTINUED_AS_NEW"],
      [1, "RUNNING"],
    ]);
    const next = chain[1];
    expect(next?.input).toEqual({ next: 4, total: 6, end: 10 });
    expect(next?.continuedFromRunId).toBe(firstRunId);
    expect(await history(next?.runId ?? "")).toEqual([
      { type: "run_started", workflowType: "ticker", input: { next: 4, total: 6, end: 10 } },
    ]);
    expect(await pendingTaskReasons(next?.runId ?? "")).toEqual(["continue_as_new"]);
    expect((await history(firstRunId)).at(-1)).toEqual({
      type: "run_continued_as_new",
      input: { next: 4, total: 6, end: 10 },
    });
  });

  it("queries the whole chain by the first run id and ends with the right result", async () => {
    const firstRunId = await startRun("ticker", { next: 1, total: 0, end: 10 });

    await driveChain(firstRunId, { next: 1, total: 0, end: 10 });

    const chain = await readRunChain(database.pool, firstRunId);
    expect(chain.map((run) => run.chainIndex)).toEqual([0, 1, 2, 3]);
    expect(chain.map((run) => run.status)).toEqual([
      "CONTINUED_AS_NEW",
      "CONTINUED_AS_NEW",
      "CONTINUED_AS_NEW",
      "COMPLETED",
    ]);
    expect(chain[3]?.result).toBe(55);
    expect(
      chain.every(
        (run, index) => index === 0 || run.continuedFromRunId === chain[index - 1]?.runId,
      ),
    ).toBe(true);
    const rows = await database.pool.query<{ first_run_id: string }>(
      "select first_run_id from workflow_runs",
    );
    expect(new Set(rows.rows.map((row) => row.first_run_id))).toEqual(new Set([firstRunId]));
  });

  it("keeps each run's history at one batch however long the chain gets", async () => {
    const firstRunId = await startRun("ticker", { next: 1, total: 0, end: 60 });

    await driveChain(firstRunId, { next: 1, total: 0, end: 60 });

    const chain = await readRunChain(database.pool, firstRunId);
    expect(chain).toHaveLength(20);
    const counts = await database.pool.query<{ events: string }>(
      "select count(*) as events from run_events group by run_id",
    );
    const sizes = new Set(counts.rows.map((row) => Number(row.events)));
    expect([...sizes]).toEqual([8]);
  });

  it("creates the next run once when the same workflow task is delivered twice", async () => {
    const firstRunId = await startRun("ticker", { next: 1, total: 0, end: 10 });
    const workflowInput = { next: 1, total: 0, end: 10 };
    for (let round = 0; round < PER_RUN; round += 1) {
      await finishSteps(firstRunId, await decide(firstRunId, ticker, workflowInput));
    }
    const events = await history(firstRunId);
    const decision = await runDecisionLoop(ticker.handler, workflowInput, events, sources);
    const input = {
      runId: firstRunId,
      taskKey: "same-task",
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    };

    const [first, second] = await Promise.all([
      recorder.recordWorkflowTaskResult(input),
      recorder.recordWorkflowTaskResult(input),
    ]);

    expect(decision.outcome).toBe("continued_as_new");
    expect([first.recorded, second.recorded].sort()).toEqual([false, true]);
    expect(await readRunChain(database.pool, firstRunId)).toHaveLength(2);
  });

  it("discards a step result that arrives after the run continued", async () => {
    const firstRunId = await startRun("ticker", { next: 1, total: 0, end: 10 });
    const decision = await driveRun(firstRunId, { next: 1, total: 0, end: 10 });
    expect(decision.outcome).toBe("continued_as_new");

    const late = await recorder.recordStepResult({
      runId: firstRunId,
      stepId: "step-9",
      attemptKey: "late",
      outcome: { status: "completed", result: 1 },
    });

    expect(late.recorded).toBe(false);
    expect(await status(firstRunId)).toBe("CONTINUED_AS_NEW");
  });

  it("does not report a child to its parent until the last run of the child chain closes", async () => {
    const parentId = await startRun("parent", { next: 1, total: 0, end: 5 });
    await decide(parentId, parentOfTicker, { next: 1, total: 0, end: 5 });
    const child = await database.pool.query<{ id: string }>(
      "select id from workflow_runs where parent_run_id = $1",
      [parentId],
    );
    const childFirstRunId = child.rows[0]?.id ?? "";

    const continued = await driveRun(childFirstRunId, { next: 1, total: 0, end: 5 });

    expect(continued.outcome).toBe("continued_as_new");
    expect((await history(parentId)).map((event) => event.type)).toEqual([
      "run_started",
      "child_started",
    ]);

    await driveChain(childFirstRunId, { next: 4, total: 6, end: 5 });

    expect((await history(parentId)).at(-1)).toEqual({
      type: "child_completed",
      childId: "child-1",
      result: 15,
    });
    const parentDecision = await decide(parentId, parentOfTicker, { next: 1, total: 0, end: 5 });
    expect(parentDecision).toMatchObject({ outcome: "completed", result: 30 });
  });

  it("cancels the latest run of a child chain when the parent is cancelled", async () => {
    const parentId = await startRun("parent", { next: 1, total: 0, end: 50 });
    await decide(parentId, parentOfTicker, { next: 1, total: 0, end: 50 });
    const child = await database.pool.query<{ id: string }>(
      "select id from workflow_runs where parent_run_id = $1",
      [parentId],
    );
    const childFirstRunId = child.rows[0]?.id ?? "";
    await driveRun(childFirstRunId, { next: 1, total: 0, end: 50 });
    const latest = await findCurrentRun(database.pool, childFirstRunId);
    expect(latest?.chainIndex).toBe(1);

    await control.cancelRun(parentId, "stop");
    await decide(parentId, parentOfTicker, { next: 1, total: 0, end: 50 });

    expect(await status(parentId)).toBe("CANCELLED");
    expect((await history(latest?.runId ?? "")).map((event) => event.type)).toContain(
      "cancel_requested",
    );
  });

  it("finds the current run of a chain and nothing for an unknown id", async () => {
    const firstRunId = await startRun("ticker", { next: 1, total: 0, end: 10 });
    await driveRun(firstRunId, { next: 1, total: 0, end: 10 });

    const current = await findCurrentRun(database.pool, firstRunId);

    expect(current?.chainIndex).toBe(1);
    expect(current?.status).toBe("RUNNING");
    expect(
      await findCurrentRun(database.pool, "00000000-0000-0000-0000-000000000000"),
    ).toBeUndefined();
  });

  it("treats a run that never continued as a chain of one", async () => {
    const runId = await startRun("ticker", { next: 1, total: 0, end: 2 });

    const chain = await readRunChain(database.pool, runId);

    expect(chain.map((run) => [run.runId, run.chainIndex])).toEqual([[runId, 0]]);
  });
});
