import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.ts";
import { createTimerScheduler } from "../timers/timer-scheduler.ts";
import { commandToEvent } from "../workflow/command-events.ts";
import { runDecisionLoop, type DecisionResult } from "../workflow/decision-loop.ts";
import { defineWorkflow } from "../workflow/define-workflow.ts";
import type { WorkflowHandler } from "../workflow/context.ts";
import { createEventService, type EventService } from "./external-events.ts";

const START = new Date("2026-04-01T08:00:00.000Z");

const paymentWait = defineWorkflow("payment-wait", async (ctx, input: { orderId: string }) => {
  try {
    const paid = await ctx.waitForEvent<{ amount: number }>("payment.received", {
      match: input.orderId,
      timeoutMs: 60_000,
    });
    return { paid: paid.amount };
  } catch (error) {
    return { failed: error instanceof Error ? error.name : "unknown" };
  }
});

const twoTicks = defineWorkflow("two-ticks", async (ctx) => {
  const first = await ctx.waitForEvent<number>("tick", { match: "k" });
  const second = await ctx.waitForEvent<number>("tick", { match: "k" });
  return [first, second];
});

describe("external events against postgres", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let events: EventService;
  let namespaceId: string;
  let now = START;
  let taskCounter = 0;
  const clock = { now: () => now };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: "default", clock });
    events = createEventService(database.pool, { clock });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    now = START;
    await database.pool.query("delete from event_waits");
    await database.pool.query("delete from external_events");
    await database.pool.query("delete from event_triggers");
    await database.pool.query("delete from timers");
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
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
    return runId;
  }

  async function history(runId: string): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function decide(
    runId: string,
    handler: WorkflowHandler<never>,
    input: unknown,
  ): Promise<DecisionResult> {
    const recorded = await history(runId);
    const decision = await runDecisionLoop(handler, input as never, recorded, { clock });
    taskCounter += 1;
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `task-${String(taskCounter)}`,
      expectedSeq: recorded.length,
      events: decision.commands.map(commandToEvent),
    });
    return decision;
  }

  async function status(runId: string): Promise<string> {
    const row = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0]?.status ?? "";
  }

  it("delivers an event sent before the run waits for it", async () => {
    const runId = await startRun("payment-wait", { orderId: "o-1" });
    const receipt = await events.sendEvent(namespaceId, {
      eventName: "payment.received",
      key: "o-1",
      payload: { amount: 42 },
    });
    expect(receipt.deliveredTo).toEqual([]);

    now = new Date(START.getTime() + 5_000);
    const waiting = await decide(runId, paymentWait.handler, { orderId: "o-1" });
    expect(waiting.outcome).toBe("suspended");
    expect((await history(runId)).at(-1)).toEqual({
      type: "event_received",
      waitId: "wait-1",
      eventId: receipt.eventId,
      eventName: "payment.received",
      key: "o-1",
      payload: { amount: 42 },
    });

    const finished = await decide(runId, paymentWait.handler, { orderId: "o-1" });
    expect(finished).toMatchObject({ outcome: "completed", result: { paid: 42 } });
    expect(await status(runId)).toBe("COMPLETED");
  });

  it("delivers an event to a run that is already waiting and enqueues a workflow task", async () => {
    const runId = await startRun("payment-wait", { orderId: "o-2" });
    await decide(runId, paymentWait.handler, { orderId: "o-2" });

    const receipt = await events.sendEvent(namespaceId, {
      eventName: "payment.received",
      key: "o-2",
      payload: { amount: 7 },
    });

    expect(receipt.deliveredTo).toEqual([{ runId, waitId: "wait-1" }]);
    const tasks = await database.pool.query<{ payload: { reason: string } }>(
      "select payload from tasks where run_id = $1",
      [runId],
    );
    expect(tasks.rows.map((row) => row.payload.reason)).toContain("event");
    const finished = await decide(runId, paymentWait.handler, { orderId: "o-2" });
    expect(finished).toMatchObject({ outcome: "completed", result: { paid: 7 } });
  });

  it("never delivers an event with another correlation key or name", async () => {
    const runId = await startRun("payment-wait", { orderId: "o-3" });
    await events.sendEvent(namespaceId, { eventName: "payment.received", key: "o-4" });
    await events.sendEvent(namespaceId, { eventName: "payment.refunded", key: "o-3" });

    await decide(runId, paymentWait.handler, { orderId: "o-3" });
    const receipt = await events.sendEvent(namespaceId, {
      eventName: "payment.received",
      key: "other",
    });

    expect(receipt.deliveredTo).toEqual([]);
    expect((await history(runId)).some((event) => event.type === "event_received")).toBe(false);
  });

  it("drops a buffered event once its buffer period has passed", async () => {
    const runId = await startRun("payment-wait", { orderId: "o-5" });
    await events.sendEvent(namespaceId, {
      eventName: "payment.received",
      key: "o-5",
      payload: { amount: 1 },
      bufferMs: 1_000,
    });

    now = new Date(START.getTime() + 1_000);
    await decide(runId, paymentWait.handler, { orderId: "o-5" });

    expect((await history(runId)).some((event) => event.type === "event_received")).toBe(false);
  });

  it("times out on a fake clock and stops delivering to the expired wait", async () => {
    const runId = await startRun("payment-wait", { orderId: "o-6" });
    const timers = createTimerScheduler(database.pool, { queueName: "default", clock });
    await decide(runId, paymentWait.handler, { orderId: "o-6" });

    now = new Date(START.getTime() + 59_999);
    expect((await timers.tick()).fired).toHaveLength(0);
    now = new Date(START.getTime() + 60_000);
    expect((await timers.tick()).fired).toHaveLength(1);

    const late = await events.sendEvent(namespaceId, { eventName: "payment.received", key: "o-6" });
    expect(late.deliveredTo).toEqual([]);
    const finished = await decide(runId, paymentWait.handler, { orderId: "o-6" });
    expect(finished).toMatchObject({
      outcome: "completed",
      result: { failed: "EventWaitTimeoutError" },
    });
  });

  it("gives each run one event at most once, and the next wait the next event", async () => {
    const runId = await startRun("two-ticks", {});
    await events.sendEvent(namespaceId, { eventName: "tick", key: "k", payload: 1 });
    await decide(runId, twoTicks.handler, {});
    await decide(runId, twoTicks.handler, {});
    expect((await history(runId)).filter((event) => event.type === "event_received")).toHaveLength(
      1,
    );

    await events.sendEvent(namespaceId, { eventName: "tick", key: "k", payload: 2 });
    const finished = await decide(runId, twoTicks.handler, {});

    expect(finished).toMatchObject({ outcome: "completed", result: [1, 2] });
  });

  it("delivers one event to every run waiting for it", async () => {
    const first = await startRun("payment-wait", { orderId: "shared" });
    const second = await startRun("payment-wait", { orderId: "shared" });
    await decide(first, paymentWait.handler, { orderId: "shared" });
    await decide(second, paymentWait.handler, { orderId: "shared" });

    const receipt = await events.sendEvent(namespaceId, {
      eventName: "payment.received",
      key: "shared",
      payload: { amount: 3 },
    });

    expect(new Set(receipt.deliveredTo.map((delivery) => delivery.runId))).toEqual(
      new Set([first, second]),
    );
  });

  it("pairs an event and a wait that race, whichever commits first", async () => {
    const orderIds = Array.from({ length: 10 }, (_, index) => `race-${String(index)}`);
    const runIds = await Promise.all(
      orderIds.map((orderId) => startRun("payment-wait", { orderId })),
    );

    await Promise.all(
      orderIds.flatMap((orderId, index) => [
        events.sendEvent(namespaceId, {
          eventName: "payment.received",
          key: orderId,
          payload: { amount: index },
        }),
        decide(runIds[index] ?? "", paymentWait.handler, { orderId }),
      ]),
    );

    for (const [index, runId] of runIds.entries()) {
      const finished = await decide(runId, paymentWait.handler, { orderId: orderIds[index] });
      expect(finished).toMatchObject({ outcome: "completed", result: { paid: index } });
    }
  });

  it("starts a run for an event whose key matches a trigger, once per event", async () => {
    const keyed = await events.createTrigger(namespaceId, {
      eventName: "order.placed",
      key: "vip",
      workflowType: "vip-order",
    });
    await events.createTrigger(namespaceId, { eventName: "order.placed", workflowType: "audit" });

    const matching = await events.sendEvent(namespaceId, {
      eventName: "order.placed",
      key: "vip",
      payload: { total: 99 },
    });
    const other = await events.sendEvent(namespaceId, { eventName: "order.placed", key: "plain" });

    expect(matching.startedRunIds).toHaveLength(2);
    expect(other.startedRunIds).toHaveLength(1);
    const runs = await database.pool.query<{ workflow_type: string; input: unknown }>(
      "select workflow_type, input from workflow_runs where id = any($1::uuid[]) order by workflow_type",
      [[...matching.startedRunIds]],
    );
    expect(runs.rows).toEqual([
      {
        workflow_type: "audit",
        input: {
          eventId: matching.eventId,
          eventName: "order.placed",
          key: "vip",
          payload: { total: 99 },
        },
      },
      {
        workflow_type: "vip-order",
        input: {
          eventId: matching.eventId,
          eventName: "order.placed",
          key: "vip",
          payload: { total: 99 },
        },
      },
    ]);
    const tasks = await database.pool.query("select 1 from tasks where run_id = any($1::uuid[])", [
      [...matching.startedRunIds, ...other.startedRunIds],
    ]);
    expect(tasks.rowCount).toBe(3);
    expect((await events.listTriggers(namespaceId)).map((trigger) => trigger.id)).toContain(
      keyed.id,
    );
  });

  it("refuses an empty event name and a buffer out of range", async () => {
    await expect(events.sendEvent(namespaceId, { eventName: "", key: "k" })).rejects.toThrow(
      RangeError,
    );
    await expect(
      events.sendEvent(namespaceId, { eventName: "e", key: "k", bufferMs: -1 }),
    ).rejects.toThrow(/bufferMs/);
    const stored = await database.pool.query("select 1 from external_events");
    expect(stored.rowCount).toBe(0);
  });
});
