import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTaskQueue, defineStep, defineWorkflow, type Pool } from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.js";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { createShiftableClock, type ShiftableClock } from "../chaos/world.js";
import { startEngine, type Engine } from "./runtime.js";
import {
  UnknownWorkflowError,
  createEngineTaskHandler,
  type AnyStepDefinition,
  type AnyWorkflowDefinition,
} from "./task-handler.js";

interface RunRow {
  status: string;
  result: unknown;
  error: { name: string; message: string } | null;
}

describe("engine runtime against postgres", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let namespaceId: string;
  let service: RunService;
  let clock: ShiftableClock;
  let engine: Engine | undefined;
  const errors: unknown[] = [];
  const stepCalls = new Map<string, number>();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
    service = createRunService(pool, { queueName: "default" });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await pool.query("truncate namespaces cascade");
    const namespace = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    clock = createShiftableClock();
    errors.length = 0;
    stepCalls.clear();
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  function boot(
    workflows: readonly AnyWorkflowDefinition[],
    steps: readonly AnyStepDefinition[],
  ): Engine {
    engine = startEngine({
      pool,
      workflows,
      steps,
      clock,
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      concurrency: 4,
      stalledRunGraceMs: 60_000,
      shutdownTimeoutMs: 2_000,
      onError: (error) => {
        errors.push(error);
      },
    });
    return engine;
  }

  async function start(workflowType: string, input?: unknown): Promise<string> {
    const started = await service.startRun(namespaceId, {
      workflowType,
      ...(input === undefined ? {} : { input }),
    });
    return started.run.runId;
  }

  async function row(runId: string): Promise<RunRow> {
    const result = await pool.query<RunRow>(
      "select status, result, error from workflow_runs where id = $1",
      [runId],
    );
    const found = result.rows[0];
    if (found === undefined) {
      throw new Error(`run ${runId} does not exist`);
    }
    return found;
  }

  async function settled(runId: string, shiftMs = 0): Promise<RunRow> {
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      const current = await row(runId);
      if (current.status !== "RUNNING") {
        return current;
      }
      if (shiftMs > 0) {
        clock.shift(shiftMs);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run ${runId} did not settle`);
  }

  async function eventTypes(runId: string): Promise<string[]> {
    const result = await pool.query<{ type: string }>(
      "select payload ->> 'type' as type from run_events where run_id = $1 order by sequence_number",
      [runId],
    );
    return result.rows.map((entry) => entry.type);
  }

  it("runs a workflow with two steps to completion and records the result", async () => {
    const double = defineStep<{ value: number }, number>("double", {
      handler: ({ value }) => value * 2,
    });
    const flow = defineWorkflow("flow", async (ctx, input: { value: number }) => {
      const first = await ctx.step<number>("double", input);
      return ctx.step<number>("double", { value: first });
    });
    boot([flow], [double]);
    const runId = await start("flow", { value: 5 });
    const finished = await settled(runId);
    expect(finished).toMatchObject({ status: "COMPLETED", result: 20 });
    expect(await eventTypes(runId)).toEqual([
      "run_started",
      "step_scheduled",
      "step_completed",
      "step_scheduled",
      "step_completed",
      "run_completed",
    ]);
    expect(errors).toEqual([]);
  });

  it("retries a failing step with its backoff and then completes", async () => {
    const flaky = defineStep<unknown, string>("flaky", {
      retry: { initialIntervalMs: 1_000, backoffCoefficient: 2, jitter: 0, maxAttempts: 4 },
      handler: () => {
        const calls = (stepCalls.get("flaky") ?? 0) + 1;
        stepCalls.set("flaky", calls);
        if (calls < 3) {
          throw new Error(`attempt ${String(calls)} failed`);
        }
        return "ok";
      },
    });
    const flow = defineWorkflow("flaky-flow", (ctx) => ctx.step<string>("flaky", {}));
    boot([flow], [flaky]);
    const runId = await start("flaky-flow");
    const finished = await settled(runId, 500);
    expect(finished).toMatchObject({ status: "COMPLETED", result: "ok" });
    expect(stepCalls.get("flaky")).toBe(3);
    const types = await eventTypes(runId);
    expect(types.filter((type) => type === "step_attempt_failed")).toHaveLength(2);
    expect(types.filter((type) => type === "step_completed")).toHaveLength(1);
  });

  it("parks a step that used all its attempts in the dead letter queue and leaves the run open", async () => {
    const broken = defineStep<unknown, string>("broken", {
      retry: { initialIntervalMs: 100, jitter: 0, maxAttempts: 2 },
      handler: () => {
        throw new Error("always");
      },
    });
    const flow = defineWorkflow("broken-flow", (ctx) => ctx.step<string>("broken", {}));
    boot([flow], [broken]);
    const runId = await start("broken-flow");
    for (let round = 0; round < 400; round += 1) {
      clock.shift(200);
      const letters = await pool.query("select 1 from dead_letters where run_id = $1", [runId]);
      if (letters.rowCount === 1) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const letters = await pool.query("select attempts from dead_letters where run_id = $1", [
      runId,
    ]);
    expect(letters.rows).toHaveLength(1);
    expect((await row(runId)).status).toBe("RUNNING");
  });

  it("completes a run that sleeps once the clock passes the timer", async () => {
    const flow = defineWorkflow("sleeper", async (ctx) => {
      await ctx.sleep(3_600_000);
      return "awake";
    });
    boot([flow], []);
    const runId = await start("sleeper");
    for (let round = 0; round < 50; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect((await row(runId)).status).toBe("RUNNING");
    clock.shift(3_600_001);
    expect(await settled(runId)).toMatchObject({ status: "COMPLETED", result: "awake" });
  });

  it("delivers a signal sent to a waiting run", async () => {
    const flow = defineWorkflow("approval", async (ctx) => {
      const decision = await ctx.waitForSignal<{ approved: boolean }>("decision");
      return decision.approved ? "shipped" : "released";
    });
    boot([flow], []);
    const runId = await start("approval");
    await service.signalRun(namespaceId, runId, "decision", { approved: true });
    expect(await settled(runId)).toMatchObject({ status: "COMPLETED", result: "shipped" });
  });

  it("runs compensations in reverse order when a run is cancelled", async () => {
    const calls: string[] = [];
    const book = defineStep<{ what: string }, string>("book", { handler: ({ what }) => what });
    const undo = defineStep<{ what: string }, string>("undo", {
      handler: ({ what }) => {
        calls.push(what);
        return what;
      },
    });
    const saga = defineWorkflow("saga", async (ctx) => {
      await ctx.step("book", { what: "flight" });
      ctx.onCancel(async (inner) => {
        await inner.step("undo", { what: "flight" });
      });
      await ctx.step("book", { what: "hotel" });
      ctx.onCancel(async (inner) => {
        await inner.step("undo", { what: "hotel" });
      });
      await ctx.waitForSignal("never");
    });
    boot([saga], [book, undo]);
    const runId = await start("saga");
    for (let round = 0; round < 400; round += 1) {
      if ((await eventTypes(runId)).filter((type) => type === "step_completed").length === 2) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await service.cancelRun(namespaceId, runId, "customer changed their mind");
    expect((await settled(runId)).status).toBe("CANCELLED");
    expect(calls).toEqual(["hotel", "flight"]);
  });

  it("runs a child workflow and hands its result to the parent", async () => {
    const square = defineStep<{ n: number }, number>("square", { handler: ({ n }) => n * n });
    const child = defineWorkflow("square-child", (ctx, input: { n: number }) =>
      ctx.step<number>("square", input),
    );
    const parent = defineWorkflow("square-parent", async (ctx) => {
      const results = await ctx.all(
        [1, 2, 3].map((n) => () => ctx.executeChild<number>("square-child", { n })),
      );
      return results.reduce((sum, value) => sum + value, 0);
    });
    boot([parent, child], [square]);
    const runId = await start("square-parent");
    expect(await settled(runId)).toMatchObject({ status: "COMPLETED", result: 14 });
  });

  it("starts runs from a cron schedule when the clock reaches the next trigger", async () => {
    const tick = defineStep<unknown, string>("tick", { handler: () => "tock" });
    const flow = defineWorkflow("cron-flow", (ctx) => ctx.step<string>("tick", {}));
    const running = boot([flow], [tick]);
    await running.schedules.create({
      namespaceId,
      name: "every-five",
      cronExpression: "*/5 * * * *",
      workflowType: "cron-flow",
      startAt: clock.now(),
    });
    clock.shift(5 * 60_000 + 1_000);
    for (let round = 0; round < 400; round += 1) {
      const completed = await pool.query(
        "select 1 from workflow_runs where workflow_type = 'cron-flow' and status = 'COMPLETED'",
      );
      if ((completed.rowCount ?? 0) >= 1) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const completed = await pool.query(
      "select count(*) as count from workflow_runs where workflow_type = 'cron-flow' and status = 'COMPLETED'",
    );
    expect(Number((completed.rows[0] as { count: string }).count)).toBeGreaterThanOrEqual(1);
  });

  it("recreates a step task that was lost before the next workflow task", async () => {
    const echo = defineStep<{ value: string }, string>("echo", { handler: ({ value }) => value });
    const flow = defineWorkflow("echo-flow", (ctx) => ctx.step<string>("echo", { value: "hi" }));
    const queue = createTaskQueue(pool, { clock });
    const handler = createEngineTaskHandler({
      pool,
      queue,
      queueName: "default",
      workflows: [flow],
      steps: [echo],
      clock,
    });
    const runId = await start("echo-flow");
    const [workflowTask] = await queue.dequeue({
      queueName: "default",
      visibilityTimeoutMs: 30_000,
    });
    expect(workflowTask?.taskType).toBe("WORKFLOW_TASK");
    await handler(workflowTask as never, { signal: new AbortController().signal });
    await queue.ack(
      (workflowTask as { id: string }).id,
      (workflowTask as { leaseToken: string }).leaseToken,
    );
    await pool.query("delete from tasks where run_id = $1 and task_type = 'STEP_TASK'", [runId]);
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: "default",
      taskType: "WORKFLOW_TASK",
      payload: { reason: "recovered" },
    });
    const [recovery] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    await handler(recovery as never, { signal: new AbortController().signal });
    const stepTasks = await pool.query(
      "select 1 from tasks where run_id = $1 and task_type = 'STEP_TASK'",
      [runId],
    );
    expect(stepTasks.rowCount).toBe(1);
  });

  it("does not schedule a step task twice when a workflow task is delivered twice", async () => {
    const echo = defineStep<{ value: string }, string>("echo", { handler: ({ value }) => value });
    const flow = defineWorkflow("echo-flow", (ctx) => ctx.step<string>("echo", { value: "hi" }));
    const queue = createTaskQueue(pool, { clock });
    const handler = createEngineTaskHandler({
      pool,
      queue,
      queueName: "default",
      workflows: [flow],
      steps: [echo],
      clock,
    });
    const runId = await start("echo-flow");
    const [task] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    const context = { signal: new AbortController().signal };
    await handler(task as never, context);
    await handler(task as never, context);
    const stepTasks = await pool.query(
      "select 1 from tasks where run_id = $1 and task_type = 'STEP_TASK'",
      [runId],
    );
    expect(stepTasks.rowCount).toBe(1);
    expect(await eventTypes(runId)).toEqual(["run_started", "step_scheduled"]);
  });

  it("refuses a workflow task of a type the worker does not know", async () => {
    const queue = createTaskQueue(pool, { clock });
    const handler = createEngineTaskHandler({
      pool,
      queue,
      queueName: "default",
      workflows: [],
      steps: [],
      clock,
    });
    await start("mystery");
    const [task] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    await expect(
      handler(task as never, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(UnknownWorkflowError);
  });

  it("lets steps read the clock while other runs are being decided", async () => {
    const stamp = defineStep<unknown, number>("stamp", {
      handler: async () => {
        let latest = 0;
        for (let index = 0; index < 20; index += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          latest = Date.now() + Math.floor(Math.random() * 2);
        }
        return latest;
      },
    });
    const flow = defineWorkflow("stamped", async (ctx) => {
      await ctx.step("stamp", {});
      await ctx.step("stamp", {});
      return "done";
    });
    boot([flow], [stamp]);
    const runIds = await Promise.all(Array.from({ length: 12 }, () => start("stamped")));
    const finished = await Promise.all(runIds.map((runId) => settled(runId)));
    expect(finished.map((entry) => entry.status)).toEqual(runIds.map(() => "COMPLETED"));
    expect(errors).toEqual([]);
  });
});
