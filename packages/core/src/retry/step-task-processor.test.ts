import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import { createResultRecorder } from "../idempotency/recorder.js";
import { createTaskQueue, type LeasedTask, type TaskQueue } from "../queue/task-queue.js";
import { defineStep, type StepDefinition } from "../workflow/define-step.js";
import { createAttemptLog } from "./attempt-log.js";
import { createDeadLetterQueue, type DeadLetterQueue } from "./dead-letters.js";
import { NonRetryableError } from "./retry-policy.js";
import {
  createStepTaskProcessor,
  type StepTaskOutcome,
  type StepTaskProcessor,
} from "./step-task-processor.js";

const QUEUE = "default/steps";
const T0 = new Date("2026-03-01T10:00:00.000Z").getTime();

describe("step task processor", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;
  let store: EventStore;
  let queue: TaskQueue;
  let deadLetters: DeadLetterQueue;
  let processor: StepTaskProcessor;
  let nowMs = T0;
  let steps: Map<string, StepDefinition>;
  const clock = { now: () => new Date(nowMs) };
  const random = { random: () => 0.5, uuid: () => "id" };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    store = createPostgresEventStore(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from dead_letters");
    await database.pool.query("delete from step_attempts");
    await database.pool.query("delete from step_results");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
    nowMs = T0;
    steps = new Map();
    queue = createTaskQueue(database.pool, { clock });
    deadLetters = createDeadLetterQueue(database.pool, { clock });
    processor = createStepTaskProcessor({
      pool: database.pool,
      queue,
      recorder: createResultRecorder(database.pool),
      attempts: createAttemptLog(database.pool),
      deadLetters,
      lookup: (stepType) => steps.get(stepType),
      clock,
      random,
    });
  });

  const policy = {
    initialIntervalMs: 1000,
    backoffCoefficient: 2,
    maxIntervalMs: 60_000,
    maxAttempts: 3,
    jitter: 0,
  };

  async function enqueueStep(extra: Record<string, unknown> = {}): Promise<void> {
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: QUEUE,
      taskType: "STEP_TASK",
      payload: { stepId: "charge-card", stepType: "charge", input: { cents: 500 }, ...extra },
    });
  }

  async function lease(): Promise<LeasedTask | undefined> {
    const [task] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 30_000 });
    return task;
  }

  async function runOnce(): Promise<StepTaskOutcome> {
    const task = await lease();
    if (task === undefined) {
      throw new Error("no task was visible");
    }
    return processor.process(task);
  }

  async function eventTypes(): Promise<string[]> {
    return (await store.read(runId)).map((stored) => stored.event.type);
  }

  it("records a successful step and acks the task", async () => {
    steps.set("charge", defineStep("charge", { handler: () => ({ charged: true }) }));
    await enqueueStep();
    expect(await runOnce()).toEqual({ status: "completed", attempt: 1 });
    expect(await eventTypes()).toEqual(["step_completed"]);
    expect(await lease()).toBeUndefined();
  });

  it("retries a failing step after the exact backoff delays and then succeeds", async () => {
    let calls = 0;
    steps.set(
      "charge",
      defineStep("charge", {
        retry: policy,
        handler: () => {
          calls += 1;
          if (calls < 3) {
            throw new Error(`flaky ${String(calls)}`);
          }
          return "ok";
        },
      }),
    );
    await enqueueStep();

    const first = await runOnce();
    expect(first).toMatchObject({ status: "retry_scheduled", attempt: 1, delayMs: 1000 });
    expect(await lease()).toBeUndefined();

    nowMs = T0 + 999;
    expect(await lease()).toBeUndefined();
    nowMs = T0 + 1000;
    const second = await runOnce();
    expect(second).toMatchObject({ status: "retry_scheduled", attempt: 2, delayMs: 2000 });

    nowMs = T0 + 1000 + 1999;
    expect(await lease()).toBeUndefined();
    nowMs = T0 + 1000 + 2000;
    expect(await runOnce()).toEqual({ status: "completed", attempt: 3 });
    expect(calls).toBe(3);
  });

  it("writes every failed attempt to the event log with its retry time", async () => {
    steps.set(
      "charge",
      defineStep("charge", {
        retry: policy,
        handler: () => {
          throw new Error("down");
        },
      }),
    );
    await enqueueStep();
    await runOnce();
    const events = await store.read(runId);
    expect(events.map((stored) => stored.event)).toEqual([
      {
        type: "step_attempt_failed",
        stepId: "charge-card",
        attempt: 1,
        error: { name: "Error", message: "down" },
        retryAt: new Date(T0 + 1000).toISOString(),
      },
    ]);
  });

  it("never retries a NonRetryableError and fails the step for the workflow", async () => {
    let calls = 0;
    steps.set(
      "charge",
      defineStep("charge", {
        retry: policy,
        handler: () => {
          calls += 1;
          throw new NonRetryableError("card declined");
        },
      }),
    );
    await enqueueStep();
    expect(await runOnce()).toEqual({ status: "failed", attempt: 1 });
    nowMs = T0 + 10 * 60_000;
    expect(await lease()).toBeUndefined();
    expect(calls).toBe(1);
    expect(await eventTypes()).toEqual(["step_attempt_failed", "step_failed"]);
    expect(await deadLetters.list()).toEqual([]);
  });

  it("dead-letters a step that exhausts its attempts and leaves the run waiting", async () => {
    steps.set(
      "charge",
      defineStep("charge", {
        retry: policy,
        handler: () => {
          throw new Error("gateway down");
        },
      }),
    );
    await enqueueStep();
    await runOnce();
    nowMs += 1000;
    await runOnce();
    nowMs += 2000;
    const last = await runOnce();
    expect(last).toMatchObject({ status: "dead_lettered", attempt: 3 });

    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({
      runId,
      stepId: "charge-card",
      attempts: 3,
      reason: "MAX_ATTEMPTS_EXHAUSTED",
      error: { name: "Error", message: "gateway down" },
    });
    expect(await eventTypes()).toEqual([
      "step_attempt_failed",
      "step_attempt_failed",
      "step_attempt_failed",
    ]);
    nowMs += 10 * 60_000;
    expect(await lease()).toBeUndefined();
  });

  it("completes a dead-lettered step after a manual requeue with a fresh budget", async () => {
    let healthy = false;
    let calls = 0;
    steps.set(
      "charge",
      defineStep("charge", {
        retry: { ...policy, maxAttempts: 2 },
        handler: () => {
          calls += 1;
          if (!healthy) {
            throw new Error("gateway down");
          }
          return "charged";
        },
      }),
    );
    await enqueueStep();
    await runOnce();
    nowMs += 1000;
    const exhausted = await runOnce();
    expect(exhausted).toMatchObject({ status: "dead_lettered", attempt: 2 });

    healthy = true;
    const [letter] = await deadLetters.list();
    await deadLetters.requeue(letter?.id ?? "");
    expect(await runOnce()).toEqual({ status: "completed", attempt: 3 });
    expect(calls).toBe(3);
    expect((await store.read(runId)).at(-1)?.event).toEqual({
      type: "step_completed",
      stepId: "charge-card",
      result: "charged",
    });
  });

  it("gives a requeued step a full budget of attempts again", async () => {
    steps.set(
      "charge",
      defineStep("charge", {
        retry: { ...policy, maxAttempts: 2 },
        handler: () => {
          throw new Error("still down");
        },
      }),
    );
    await enqueueStep();
    await runOnce();
    nowMs += 1000;
    await runOnce();
    const [letter] = await deadLetters.list();
    await deadLetters.requeue(letter?.id ?? "");

    expect(await runOnce()).toMatchObject({ status: "retry_scheduled", attempt: 3 });
    nowMs += 1000;
    expect(await runOnce()).toMatchObject({ status: "dead_lettered", attempt: 4 });
    expect(await deadLetters.list({ includeRequeued: true })).toHaveLength(2);
  });

  it("counts a step timeout as a failed attempt", async () => {
    let fire: (() => void) | undefined;
    const timers = {
      setTimeout: (callback: () => void) => {
        fire = callback;
        return 1;
      },
      clearTimeout: () => undefined,
    };
    processor = createStepTaskProcessor({
      pool: database.pool,
      queue,
      recorder: createResultRecorder(database.pool),
      attempts: createAttemptLog(database.pool),
      deadLetters,
      lookup: (stepType) => steps.get(stepType),
      clock,
      random,
      timers,
    });
    steps.set(
      "charge",
      defineStep("charge", {
        retry: policy,
        timeoutMs: 5000,
        handler: () => new Promise<string>(() => undefined),
      }),
    );
    await enqueueStep();
    const task = await lease();
    if (task === undefined) {
      throw new Error("no task was visible");
    }
    const pending = processor.process(task);
    while (fire === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    fire();
    expect(await pending).toMatchObject({ status: "retry_scheduled", attempt: 1 });
    const [event] = await store.read(runId);
    expect(event?.event).toMatchObject({
      type: "step_attempt_failed",
      error: { name: "StepTimeoutError", message: "step timed out after 5000 ms" },
    });
  });

  it("does not use up a retry when the same attempt is redelivered after a crash", async () => {
    let calls = 0;
    steps.set(
      "charge",
      defineStep("charge", {
        retry: policy,
        handler: () => {
          calls += 1;
          return "ok";
        },
      }),
    );
    await enqueueStep();
    const lost = await lease();
    expect(lost).toBeDefined();
    nowMs += 31_000;
    expect(await runOnce()).toEqual({ status: "completed", attempt: 1 });
    expect(calls).toBe(1);
  });

  it("acks a redelivery of a step that already has a result without running it", async () => {
    let calls = 0;
    steps.set(
      "charge",
      defineStep("charge", {
        handler: () => {
          calls += 1;
          return "ok";
        },
      }),
    );
    await enqueueStep();
    await runOnce();
    await enqueueStep();
    expect(await runOnce()).toEqual({ status: "already_recorded" });
    expect(calls).toBe(1);
    expect(await eventTypes()).toEqual(["step_completed"]);
  });

  it("fails a step whose type is not registered without retrying", async () => {
    await enqueueStep({ stepType: "missing" });
    expect(await runOnce()).toEqual({ status: "failed", attempt: 1 });
    const events = await store.read(runId);
    expect(events.at(-1)?.event).toMatchObject({
      type: "step_failed",
      error: { name: "NonRetryableError" },
    });
  });

  it("uses the default retry policy when the step declares none", async () => {
    steps.set(
      "charge",
      defineStep("charge", {
        handler: () => {
          throw new Error("down");
        },
      }),
    );
    await enqueueStep();
    expect(await runOnce()).toMatchObject({ status: "retry_scheduled", delayMs: 1000 });
  });
});
