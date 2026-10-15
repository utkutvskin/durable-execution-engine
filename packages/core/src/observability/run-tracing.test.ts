import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import { createTaskQueue, type TaskQueue } from "../queue/task-queue.js";
import { createAttemptLog } from "../retry/attempt-log.js";
import { createDeadLetterQueue } from "../retry/dead-letters.js";
import { createStepTaskProcessor, type StepTaskProcessor } from "../retry/step-task-processor.js";
import { createScheduleManager } from "../schedules/schedule-manager.js";
import { createTimerScheduler, type TimerScheduler } from "../timers/timer-scheduler.js";
import { commandToEvent } from "../workflow/command-events.js";
import { runDecisionLoop } from "../workflow/decision-loop.js";
import { defineStep, type StepDefinition } from "../workflow/define-step.js";
import { defineWorkflow } from "../workflow/define-workflow.js";
import type { WorkflowHandler } from "../workflow/context.js";
import { createTracingProvider, type TracingProvider } from "./provider.js";

const STEP_QUEUE = "default/steps";
const T0 = new Date("2026-03-01T10:00:00.000Z").getTime();

const parentWorkflow = defineWorkflow("parent", async (ctx) => {
  const doubled = await ctx.step<number>("double", { value: 2 });
  await ctx.sleep(60_000);
  const fromChild = await ctx.executeChild<number>("child", { value: doubled });
  return doubled + fromChild;
});

const childWorkflow = defineWorkflow("child", async (ctx, input: { value: number }) => {
  return ctx.step<number>("double", { value: input.value });
});

const handlers: Record<string, WorkflowHandler<never>> = {
  parent: parentWorkflow.handler,
  child: childWorkflow.handler,
};

describe("run tracing", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let store: EventStore;
  let queue: TaskQueue;
  let exporter: InMemorySpanExporter;
  let provider: TracingProvider;
  let recorder: ResultRecorder;
  let processor: StepTaskProcessor;
  let timers: TimerScheduler;
  let nowMs = T0;
  let taskCounter = 0;
  let executions: number;
  const clock = { now: () => new Date(nowMs) };
  const sources = {
    clock,
    random: { random: () => 0.5, uuid: () => "fixed-uuid" },
  };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    for (const table of [
      "schedule_triggers",
      "step_attempts",
      "dead_letters",
      "timers",
      "workflow_task_results",
      "step_results",
      "tasks",
      "run_events",
      "workflow_runs",
      "schedules",
      "namespaces",
    ]) {
      await database.pool.query(`delete from ${table}`);
    }
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    nowMs = T0;
    taskCounter = 0;
    executions = 0;
    exporter = new InMemorySpanExporter();
    provider = createTracingProvider({
      serviceName: "test",
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    queue = createTaskQueue(database.pool, { clock });
    recorder = createResultRecorder(database.pool, undefined, {
      queueName: "default",
      tracing: provider.tracing,
    });
    const steps = new Map<string, StepDefinition>([
      [
        "double",
        defineStep("double", {
          handler: (input: unknown) => {
            executions += 1;
            return (input as { value: number }).value * 2;
          },
        }),
      ],
    ]);
    processor = createStepTaskProcessor({
      pool: database.pool,
      queue,
      recorder,
      attempts: createAttemptLog(database.pool),
      deadLetters: createDeadLetterQueue(database.pool, { clock }),
      lookup: (stepType) => steps.get(stepType),
      clock,
      tracing: provider.tracing,
    });
    timers = createTimerScheduler(database.pool, {
      queueName: "default",
      clock,
      tracing: provider.tracing,
    });
  });

  async function startRun(workflowType: string, input: unknown = {}): Promise<string> {
    const root = provider.tracing.startSpan("workflow.start", { kind: "server" });
    const run = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, input, traceparent)
       values ($1, $2, $3::jsonb, $4) returning id`,
      [namespaceId, workflowType, JSON.stringify(input), root.traceparent ?? null],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType, input }]);
    root.end();
    return runId;
  }

  async function history(runId: string): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function workflowTypeOf(runId: string): Promise<{ type: string; input: unknown }> {
    const row = await database.pool.query<{ workflow_type: string; input: unknown }>(
      "select workflow_type, input from workflow_runs where id = $1",
      [runId],
    );
    return { type: row.rows[0]?.workflow_type ?? "", input: row.rows[0]?.input };
  }

  async function decideOnce(runId: string): Promise<"completed" | "other"> {
    const { type, input } = await workflowTypeOf(runId);
    const handler = handlers[type];
    if (handler === undefined) {
      throw new Error(`no handler for ${type}`);
    }
    const events = await history(runId);
    const decision = await runDecisionLoop(handler, input as never, events, sources);
    taskCounter += 1;
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `task-${String(taskCounter)}`,
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    });
    for (const command of decision.commands) {
      if (command.type === "schedule_step") {
        await queue.enqueue({
          namespaceId,
          runId,
          queueName: STEP_QUEUE,
          taskType: "STEP_TASK",
          payload: { stepId: command.stepId, stepType: command.stepType, input: command.input },
        });
      }
    }
    return decision.outcome === "completed" ? "completed" : "other";
  }

  async function runSteps(): Promise<void> {
    for (;;) {
      const [task] = await queue.dequeue({ queueName: STEP_QUEUE, visibilityTimeoutMs: 30_000 });
      if (task === undefined) {
        return;
      }
      await processor.process(task);
    }
  }

  async function runToCompletion(runIds: () => Promise<string[]>): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await runSteps();
      nowMs += 60_000;
      await timers.tick();
      for (const runId of await runIds()) {
        const status = await database.pool.query<{ status: string }>(
          "select status from workflow_runs where id = $1",
          [runId],
        );
        if (status.rows[0]?.status === "RUNNING") {
          await decideOnce(runId);
        }
      }
      const open = await database.pool.query(
        "select 1 from workflow_runs where status = 'RUNNING' limit 1",
      );
      if (open.rowCount === 0) {
        return;
      }
    }
    throw new Error("the runs did not finish");
  }

  async function allRunIds(): Promise<string[]> {
    const rows = await database.pool.query<{ id: string }>(
      "select id from workflow_runs order by started_at, id",
    );
    return rows.rows.map((row) => row.id);
  }

  function spans(): ReadableSpan[] {
    return exporter.getFinishedSpans();
  }

  function named(prefix: string): ReadableSpan[] {
    return spans().filter((span) => span.name.startsWith(prefix));
  }

  async function finishParentWithChild(): Promise<string> {
    const runId = await startRun("parent");
    await runToCompletion(allRunIds);
    return runId;
  }

  it("builds one unbroken span tree for a run with a step, a timer and a child workflow", async () => {
    const runId = await finishParentWithChild();
    const status = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    expect(status.rows[0]?.status).toBe("COMPLETED");

    const all = spans();
    const traceIds = new Set(all.map((span) => span.spanContext().traceId));
    expect(traceIds.size).toBe(1);
    const ids = new Set(all.map((span) => span.spanContext().spanId));
    const roots = all.filter((span) => span.parentSpanContext === undefined);
    expect(roots.map((span) => span.name)).toEqual(["workflow.start"]);
    for (const span of all) {
      if (span.parentSpanContext !== undefined) {
        expect(ids.has(span.parentSpanContext.spanId)).toBe(true);
      }
    }
  });

  it("puts the child workflow's spans under a workflow.child span of the parent's trace", async () => {
    await finishParentWithChild();
    const [childSpan] = named("workflow.child");
    expect(childSpan).toBeDefined();
    const childRunSteps = named("step double").filter(
      (span) => span.parentSpanContext?.spanId === childSpan?.spanContext().spanId,
    );
    expect(childRunSteps).toHaveLength(1);
    expect(childRunSteps[0]?.attributes["dee.step.attempt"]).toBe(1);
  });

  it("emits one step span per executed step and one timer span per fired timer", async () => {
    await finishParentWithChild();
    expect(named("step double")).toHaveLength(2);
    expect(executions).toBe(2);
    const timerSpans = named("timer ");
    expect(timerSpans).toHaveLength(1);
    expect(timerSpans[0]?.attributes["dee.timer.late_ms"]).toBeGreaterThanOrEqual(0);
  });

  it("spans a timer from its creation to the moment it fired", async () => {
    await finishParentWithChild();
    const [timerSpan] = named("timer ");
    const [startSeconds = 0] = timerSpan?.startTime ?? [];
    const [endSeconds = 0] = timerSpan?.endTime ?? [];
    expect(endSeconds * 1000).toBeGreaterThanOrEqual(T0 + 60_000);
    expect(startSeconds * 1000).toBeLessThanOrEqual(Date.now());
    expect(endSeconds).toBeGreaterThanOrEqual(startSeconds);
  });

  it("emits no span when the history is replayed again", async () => {
    const runId = await finishParentWithChild();
    const before = spans().length;
    const events = await history(runId);
    for (let replay = 0; replay < 5; replay += 1) {
      await runDecisionLoop(parentWorkflow.handler as never, {} as never, events, sources);
    }
    expect(spans()).toHaveLength(before);
  });

  it("emits no span for a workflow task that is delivered twice", async () => {
    const runId = await startRun("parent");
    const events = await history(runId);
    const decision = await runDecisionLoop(
      parentWorkflow.handler as never,
      {} as never,
      events,
      sources,
    );
    const input = {
      runId,
      taskKey: "same-task",
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    };
    const first = await recorder.recordWorkflowTaskResult(input);
    const afterFirst = named("workflow.task").length;
    const second = await recorder.recordWorkflowTaskResult(input);
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(afterFirst).toBe(1);
    expect(named("workflow.task")).toHaveLength(1);
  });

  it("emits no step span when the step's result is already recorded", async () => {
    const runId = await startRun("parent");
    await decideOnce(runId);
    await runSteps();
    expect(named("step double")).toHaveLength(1);
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: STEP_QUEUE,
      taskType: "STEP_TASK",
      payload: { stepId: "step-1", stepType: "double", input: { value: 2 } },
    });
    await runSteps();
    expect(named("step double")).toHaveLength(1);
    expect(executions).toBe(1);
  });

  it("marks a failing step attempt's span as an error and counts attempts", async () => {
    const steps = new Map<string, StepDefinition>([
      [
        "double",
        defineStep("double", {
          handler: () => {
            throw new Error("card declined");
          },
          retry: {
            initialIntervalMs: 1000,
            backoffCoefficient: 2,
            maxIntervalMs: 60_000,
            maxAttempts: 2,
            jitter: 0,
          },
        }),
      ],
    ]);
    processor = createStepTaskProcessor({
      pool: database.pool,
      queue,
      recorder,
      attempts: createAttemptLog(database.pool),
      deadLetters: createDeadLetterQueue(database.pool, { clock }),
      lookup: (stepType) => steps.get(stepType),
      clock,
      tracing: provider.tracing,
    });
    const runId = await startRun("parent");
    await decideOnce(runId);
    await runSteps();
    nowMs += 1000;
    await runSteps();
    const attempts = named("step double");
    expect(attempts.map((span) => span.attributes["dee.step.attempt"])).toEqual([1, 2]);
    expect(attempts.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true);
    expect(attempts[0]?.status.message).toBe("card declined");
  });

  it("drops the child span when the transaction that created the child rolls back", async () => {
    const runId = await startRun("parent");
    await decideOnce(runId);
    await runSteps();
    nowMs += 60_000;
    await decideOnce(runId);
    await timers.tick();
    const events = await history(runId);
    const decision = await runDecisionLoop(
      parentWorkflow.handler as never,
      {} as never,
      events,
      sources,
    );
    const failing = createResultRecorder(database.pool, undefined, {
      queueName: "default",
      tracing: provider.tracing,
    });
    await database.pool.query("alter table workflow_task_results rename to results_hidden");
    await expect(
      failing.recordWorkflowTaskResult({
        runId,
        taskKey: "doomed",
        expectedSeq: events.length,
        events: decision.commands.map(commandToEvent),
      }),
    ).rejects.toThrow();
    await database.pool.query("alter table results_hidden rename to workflow_task_results");
    expect(named("workflow.child")).toHaveLength(0);
    const children = await database.pool.query(
      "select 1 from workflow_runs where parent_run_id = $1",
      [runId],
    );
    expect(children.rowCount).toBe(0);
  });

  it("stores the trace context on the child run and on a continued run", async () => {
    await finishParentWithChild();
    const rows = await database.pool.query<{ traceparent: string | null }>(
      "select traceparent from workflow_runs order by started_at, id",
    );
    expect(rows.rows).toHaveLength(2);
    const [parentContext, childContext] = rows.rows.map((row) => row.traceparent ?? "");
    expect(parentContext?.split("-")[1]).toBe(childContext?.split("-")[1]);
    expect(parentContext).not.toBe(childContext);
  });

  it("starts a trace for a scheduled run and hangs its spans under it", async () => {
    const manager = createScheduleManager(database.pool, {
      queueName: "default",
      clock,
      tracing: provider.tracing,
    });
    await manager.create({
      namespaceId,
      name: "nightly",
      cronExpression: "*/5 * * * *",
      workflowType: "child",
      input: { value: 3 },
    });
    nowMs += 5 * 60_000;
    await manager.tick();
    const scheduleSpans = named("workflow.schedule");
    expect(scheduleSpans).toHaveLength(1);
    const run = await database.pool.query<{ id: string; traceparent: string }>(
      "select id, traceparent from workflow_runs",
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]?.traceparent.split("-")[2]).toBe(scheduleSpans[0]?.spanContext().spanId);
  });

  it("leaves a run untraced when no tracing is configured", async () => {
    const plain = createResultRecorder(database.pool, undefined, { queueName: "default" });
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'parent') returning id",
      [namespaceId],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "parent", input: {} }]);
    const result = await plain.recordWorkflowTaskResult({
      runId,
      taskKey: "plain",
      expectedSeq: 1,
      events: [],
    });
    expect(result.recorded).toBe(true);
    expect(spans()).toHaveLength(0);
  });
});
