import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRunControl, type RunControl } from "../cancellation/run-control.js";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { ParentClosePolicy, WorkflowEvent } from "../event-store/events.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import { commandToEvent } from "../workflow/command-events.js";
import { runDecisionLoop } from "../workflow/decision-loop.js";
import { defineWorkflow } from "../workflow/define-workflow.js";
import type { ClockSource, RandomSource } from "../workflow/sources.js";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

const fanOut = defineWorkflow("fan-out", async (ctx, input: { count: number }) => {
  const squares = await ctx.all(
    Array.from(
      { length: input.count },
      (_, index) => () => ctx.executeChild<number>("square", { value: index + 1 }),
    ),
  );
  return squares.reduce((total, value) => total + value, 0);
});

function withPolicies(policies: ParentClosePolicy[]) {
  return defineWorkflow("with-policies", async (ctx) => {
    ctx.onCancel(async (compensation) => {
      await compensation.step("cleanup", {});
    });
    const handles = policies.map((parentClosePolicy) =>
      ctx.startChild("long-running", {}, { parentClosePolicy }),
    );
    return ctx.all(handles.map((handle) => () => handle.result));
  });
}

describe("child runs", () => {
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
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from step_results");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from namespaces");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  async function startRun(workflowType: string, input: unknown = {}): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, input) values ($1, $2, $3::jsonb) returning id",
      [namespaceId, workflowType, JSON.stringify(input)],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType, input }]);
    return runId;
  }

  async function history(runId: string): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function decide(
    runId: string,
    workflow: ReturnType<typeof defineWorkflow<never, unknown>>,
    input: unknown = {},
  ) {
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

  async function closeRun(runId: string, event: WorkflowEvent): Promise<void> {
    const events = await history(runId);
    taskCounter += 1;
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `close-${String(taskCounter)}`,
      expectedSeq: events.length,
      events: [event],
    });
  }

  async function children(
    parentRunId: string,
  ): Promise<{ id: string; child: string; status: string; policy: string }[]> {
    const rows = await database.pool.query<{
      id: string;
      parent_child_id: string;
      status: string;
      parent_close_policy: string;
    }>(
      `select id, parent_child_id, status, parent_close_policy from workflow_runs
       where parent_run_id = $1 order by length(parent_child_id), parent_child_id`,
      [parentRunId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      child: row.parent_child_id,
      status: row.status,
      policy: row.parent_close_policy,
    }));
  }

  async function status(runId: string): Promise<string> {
    const row = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0]?.status ?? "";
  }

  async function pendingTaskReasons(runId: string): Promise<string[]> {
    const rows = await database.pool.query<{ payload: { reason: string } }>(
      "select payload from tasks where run_id = $1 and state = 'PENDING' order by created_at",
      [runId],
    );
    return rows.rows.map((row) => row.payload.reason);
  }

  it("creates a linked child run with its start event and first task", async () => {
    const parentId = await startRun("fan-out", { count: 1 });

    await decide(parentId, fanOut, { count: 1 });

    const [child] = await children(parentId);
    expect(child).toMatchObject({ child: "child-1", status: "RUNNING", policy: "cancel" });
    expect(await history(child?.id ?? "")).toEqual([
      { type: "run_started", workflowType: "square", input: { value: 1 } },
    ]);
    expect(await pendingTaskReasons(child?.id ?? "")).toEqual(["child_started"]);
  });

  it("creates the child once when the same workflow task is delivered again", async () => {
    const parentId = await startRun("fan-out", { count: 3 });
    const events = await history(parentId);
    const decision = await runDecisionLoop(fanOut.handler, { count: 3 }, events, sources);
    const input = {
      runId: parentId,
      taskKey: "same-task",
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    };

    const [first, second] = await Promise.all([
      recorder.recordWorkflowTaskResult(input),
      recorder.recordWorkflowTaskResult(input),
    ]);

    expect([first.recorded, second.recorded].sort()).toEqual([false, true]);
    expect(await children(parentId)).toHaveLength(3);
  });

  it("refuses to start a child when the recorder has no queue name", async () => {
    const bare = createResultRecorder(database.pool);
    const parentId = await startRun("fan-out", { count: 1 });
    const events = await history(parentId);

    await expect(
      bare.recordWorkflowTaskResult({
        runId: parentId,
        taskKey: "no-queue",
        expectedSeq: events.length,
        events: [
          {
            type: "child_started",
            childId: "child-1",
            workflowType: "square",
            input: {},
            parentClosePolicy: "cancel",
          },
        ],
      }),
    ).rejects.toThrow("queueName");
    expect(await children(parentId)).toHaveLength(0);
    expect(await history(parentId)).toHaveLength(1);
  });

  it("records a completed child's result in the parent and wakes the parent", async () => {
    const parentId = await startRun("fan-out", { count: 1 });
    await decide(parentId, fanOut, { count: 1 });
    const [child] = await children(parentId);

    await closeRun(child?.id ?? "", { type: "run_completed", result: 1 });

    expect((await history(parentId)).at(-1)).toEqual({
      type: "child_completed",
      childId: "child-1",
      result: 1,
    });
    expect(await pendingTaskReasons(parentId)).toEqual(["child_closed"]);
    expect(await status(child?.id ?? "")).toBe("COMPLETED");
    const decision = await decide(parentId, fanOut, { count: 1 });
    expect(decision).toMatchObject({ outcome: "completed", result: 1 });
  });

  it("records a failed child as child_failed with the child's error", async () => {
    const parentId = await startRun("fan-out", { count: 1 });
    await decide(parentId, fanOut, { count: 1 });
    const [child] = await children(parentId);

    await closeRun(child?.id ?? "", {
      type: "run_failed",
      error: { name: "PaymentError", message: "card declined" },
    });

    expect((await history(parentId)).at(-1)).toEqual({
      type: "child_failed",
      childId: "child-1",
      error: { name: "PaymentError", message: "card declined" },
    });
    const decision = await decide(parentId, fanOut, { count: 1 });
    expect(decision.outcome === "failed" && decision.error.message).toBe("card declined");
  });

  it("completes a fan-out of 100 children with the correct aggregate", async () => {
    const parentId = await startRun("fan-out", { count: 100 });
    const first = await decide(parentId, fanOut, { count: 100 });
    expect(first.commands).toHaveLength(100);
    const created = await children(parentId);
    expect(created).toHaveLength(100);

    const shuffled = [...created].sort((a, b) => (a.id < b.id ? 1 : -1));
    for (const child of shuffled) {
      const value = Number(child.child.replace("child-", ""));
      await closeRun(child.id, { type: "run_completed", result: value * value });
    }

    const parentEvents = await history(parentId);
    expect(parentEvents.filter((event) => event.type === "child_completed")).toHaveLength(100);
    const final = await decide(parentId, fanOut, { count: 100 });
    expect(final).toMatchObject({ outcome: "completed", result: 338_350 });
    expect(await status(parentId)).toBe("COMPLETED");
  });

  it("cancels cancel children, terminates terminate children and leaves abandon children running", async () => {
    const workflow = withPolicies(["cancel", "abandon", "terminate"]);
    const parentId = await startRun("with-policies");
    await decide(parentId, workflow);
    const [cancelChild, abandonChild, terminateChild] = await children(parentId);

    await control.cancelRun(parentId, "customer");
    await decide(parentId, workflow);
    await closeRun(parentId, { type: "step_completed", stepId: "step-1", result: null });
    await decide(parentId, workflow);

    expect(await status(parentId)).toBe("CANCELLED");
    expect(await status(cancelChild?.id ?? "")).toBe("RUNNING");
    expect((await history(cancelChild?.id ?? "")).at(-1)).toEqual({
      type: "cancel_requested",
      reason: "parent run closed",
    });
    expect(await pendingTaskReasons(cancelChild?.id ?? "")).toContain("cancel");
    expect(await status(terminateChild?.id ?? "")).toBe("TERMINATED");
    expect(await status(abandonChild?.id ?? "")).toBe("RUNNING");
    expect(await history(abandonChild?.id ?? "")).toHaveLength(1);
  });

  it("does not notify a closed parent when an abandoned child finishes later", async () => {
    const workflow = withPolicies(["abandon"]);
    const parentId = await startRun("with-policies");
    await decide(parentId, workflow);
    const [abandoned] = await children(parentId);
    await control.terminateRun(parentId, "stop");
    const parentHistory = await history(parentId);

    await closeRun(abandoned?.id ?? "", { type: "run_completed", result: "late" });

    expect(await history(parentId)).toEqual(parentHistory);
    expect(await status(abandoned?.id ?? "")).toBe("COMPLETED");
  });

  it("applies the close policy of every level when the root is terminated", async () => {
    const root = defineWorkflow("root", async (ctx) => ctx.executeChild("middle", {}));
    const rootId = await startRun("root");
    await decide(rootId, root);
    const [middle] = await children(rootId);
    const middleRun = middle?.id ?? "";
    const middleWorkflow = defineWorkflow("middle", async (ctx) =>
      ctx.executeChild("long-running", {}, { parentClosePolicy: "terminate" }),
    );
    await decide(middleRun, middleWorkflow);
    const [leaf] = await children(middleRun);
    await database.pool.query(
      "update workflow_runs set parent_close_policy = 'terminate' where id = $1",
      [middleRun],
    );

    await control.terminateRun(rootId);

    expect(await status(rootId)).toBe("TERMINATED");
    expect(await status(middleRun)).toBe("TERMINATED");
    expect(await status(leaf?.id ?? "")).toBe("TERMINATED");
  });

  it("closes parents and children concurrently without deadlocking", async () => {
    const workflow = withPolicies(["cancel", "terminate", "abandon", "cancel"]);
    const parentIds: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      const parentId = await startRun("with-policies");
      await decide(parentId, workflow);
      parentIds.push(parentId);
    }

    const operations: Promise<unknown>[] = [];
    for (const [index, parentId] of parentIds.entries()) {
      const kids = await children(parentId);
      for (const kid of kids) {
        operations.push(
          closeRun(kid.id, { type: "run_completed", result: index }).catch(() => undefined),
        );
      }
      operations.push(control.terminateRun(parentId).catch(() => undefined));
    }

    await Promise.all(operations);

    for (const parentId of parentIds) {
      expect(await status(parentId)).not.toBe("RUNNING");
      for (const kid of await children(parentId)) {
        expect(["COMPLETED", "TERMINATED", "RUNNING"]).toContain(kid.status);
      }
    }
  });
});
