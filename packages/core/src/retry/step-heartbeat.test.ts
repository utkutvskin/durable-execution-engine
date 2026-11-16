import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { createResultRecorder } from "../idempotency/recorder.ts";
import { createTaskQueue, type LeasedTask, type TaskQueue } from "../queue/task-queue.ts";
import { defineStep, type StepDefinition } from "../workflow/define-step.ts";
import type { StepContext } from "../workflow/step-registry.ts";
import { createAttemptLog } from "./attempt-log.ts";
import { createDeadLetterQueue, type DeadLetterQueue } from "./dead-letters.ts";
import { createHeartbeatStore, type HeartbeatStore } from "./heartbeats.ts";
import {
  createStepTaskProcessor,
  type StepTaskOutcome,
  type StepTaskProcessor,
} from "./step-task-processor.ts";
import type { TimeoutTimers } from "./timeout.ts";

const QUEUE = "default/steps";
const T0 = new Date("2026-04-01T08:00:00.000Z").getTime();

interface PendingTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

function createFakeClock(): {
  readonly clock: { now(): Date };
  readonly timers: TimeoutTimers;
  advance(ms: number): void;
  set(ms: number): void;
  pending(): number;
} {
  let nowMs = T0;
  let nextId = 0;
  let pending: PendingTimer[] = [];
  const fireDue = (): void => {
    const due = pending.filter((timer) => timer.dueAt <= nowMs);
    pending = pending.filter((timer) => timer.dueAt > nowMs);
    for (const timer of due) {
      timer.callback();
    }
  };
  return {
    clock: { now: () => new Date(nowMs) },
    timers: {
      setTimeout(callback, delayMs) {
        nextId += 1;
        pending.push({ id: nextId, dueAt: nowMs + delayMs, callback });
        return nextId;
      },
      clearTimeout(handle) {
        pending = pending.filter((timer) => timer.id !== handle);
      },
    },
    advance(ms) {
      nowMs += ms;
      fireDue();
    },
    set(ms) {
      nowMs = ms;
      fireDue();
    },
    pending: () => pending.length,
  };
}

async function turn(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const policy = {
  initialIntervalMs: 1000,
  backoffCoefficient: 2,
  maxIntervalMs: 60_000,
  maxAttempts: 10,
  jitter: 0,
};

describe("step heartbeats and step timeouts", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;
  let store: EventStore;
  let queue: TaskQueue;
  let deadLetters: DeadLetterQueue;
  let heartbeats: HeartbeatStore;
  let processor: StepTaskProcessor;
  let fake: ReturnType<typeof createFakeClock>;
  let steps: Map<string, StepDefinition>;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    store = createPostgresEventStore(database.pool);
    heartbeats = createHeartbeatStore(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    for (const table of [
      "dead_letters",
      "step_heartbeats",
      "step_attempts",
      "step_results",
      "tasks",
      "run_events",
      "workflow_runs",
    ]) {
      await database.pool.query(`delete from ${table}`);
    }
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'import-file') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
    fake = createFakeClock();
    steps = new Map();
    queue = createTaskQueue(database.pool, { clock: fake.clock });
    deadLetters = createDeadLetterQueue(database.pool, { clock: fake.clock });
    processor = createStepTaskProcessor({
      pool: database.pool,
      queue,
      recorder: createResultRecorder(database.pool),
      attempts: createAttemptLog(database.pool),
      deadLetters,
      lookup: (stepType) => steps.get(stepType),
      clock: fake.clock,
      random: { random: () => 0.5, uuid: () => "id" },
      timers: fake.timers,
      heartbeats,
    });
  });

  async function enqueueStep(scheduledAt: number = T0): Promise<void> {
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: QUEUE,
      taskType: "STEP_TASK",
      payload: {
        stepId: "step-1",
        stepType: "import",
        input: { rows: 5 },
        scheduledAt: new Date(scheduledAt).toISOString(),
      },
    });
  }

  async function lease(): Promise<LeasedTask> {
    const [task] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 600_000 });
    if (task === undefined) {
      throw new Error("no task was visible");
    }
    return task;
  }

  async function events(): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function waitForTimers(count: number): Promise<void> {
    while (fake.pending() < count) {
      await turn();
    }
  }

  it("retries a step that stopped heartbeating after the heartbeat timeout and resumes from its last details", async () => {
    const seen: StepContext[] = [];
    const progress: number[] = [];
    let release: (() => void) | undefined;
    steps.set(
      "import",
      defineStep("import", {
        retry: policy,
        heartbeatTimeoutMs: 1000,
        handler: async (_input, context) => {
          seen.push(context);
          const resumeAt =
            typeof context.heartbeatDetails === "number" ? context.heartbeatDetails + 1 : 1;
          for (let row = resumeAt; row <= 5; row += 1) {
            if (context.attempt === 1 && row === 4) {
              await new Promise<void>(() => undefined);
            }
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            progress.push(row);
            context.heartbeat(row);
          }
          return progress;
        },
      }),
    );
    await enqueueStep();

    const first = processor.process(await lease());
    for (let row = 1; row <= 3; row += 1) {
      await waitForTimers(1);
      while (release === undefined) {
        await turn();
      }
      fake.advance(900);
      const next = release;
      release = undefined;
      next();
      await turn();
    }
    fake.advance(999);
    await turn();
    expect(seen[0]?.signal.aborted).toBe(false);
    fake.advance(1);
    const outcome: StepTaskOutcome = await first;
    expect(await heartbeats.read(runId, "step-1")).toMatchObject({ attempt: 1, details: 3 });

    expect(outcome).toMatchObject({ status: "retry_scheduled", attempt: 1, delayMs: 1000 });
    expect(await events()).toEqual([
      expect.objectContaining({
        type: "step_attempt_failed",
        attempt: 1,
        error: { name: "StepHeartbeatTimeoutError", message: "step sent no heartbeat for 1000 ms" },
      }),
    ]);
    expect(seen[0]?.signal.aborted).toBe(true);

    fake.advance(1000);
    const second = processor.process(await lease());
    for (let row = 4; row <= 5; row += 1) {
      while (release === undefined) {
        await turn();
      }
      const next = release;
      release = undefined;
      next();
      await turn();
    }

    expect(await second).toEqual({ status: "completed", attempt: 2 });
    expect(seen.map((context) => [context.attempt, context.heartbeatDetails])).toEqual([
      [1, undefined],
      [2, 3],
    ]);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect((await events()).at(-1)).toMatchObject({
      type: "step_completed",
      result: [1, 2, 3, 4, 5],
    });
  });

  it("keeps a step that heartbeats in time alive past many heartbeat timeouts", async () => {
    let beat: ((details: unknown) => void) | undefined;
    let finish: ((value: string) => void) | undefined;
    steps.set(
      "import",
      defineStep("import", {
        heartbeatTimeoutMs: 1000,
        handler: (_input, context) =>
          new Promise<string>((resolve) => {
            beat = (details): void => {
              context.heartbeat(details);
            };
            finish = resolve;
          }),
      }),
    );
    await enqueueStep();
    const processing = processor.process(await lease());
    while (beat === undefined) {
      await turn();
    }
    for (let index = 1; index <= 6; index += 1) {
      fake.advance(800);
      beat({ chunk: index });
      await turn();
    }
    finish?.("done");

    expect(await processing).toEqual({ status: "completed", attempt: 1 });
    expect(await heartbeats.read(runId, "step-1")).toMatchObject({
      attempt: 1,
      details: { chunk: 6 },
    });
    expect(fake.pending()).toBe(0);
  });

  it("fails a step with a StepScheduleToCloseTimeoutError instead of retrying past its schedule-to-close deadline", async () => {
    let calls = 0;
    steps.set(
      "import",
      defineStep("import", {
        retry: policy,
        scheduleToCloseTimeoutMs: 10_000,
        handler: () => {
          calls += 1;
          throw new Error(`upstream busy ${String(calls)}`);
        },
      }),
    );
    await enqueueStep();

    const outcomes: StepTaskOutcome[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const outcome = await processor.process(await lease());
      outcomes.push(outcome);
      if (outcome.status === "retry_scheduled") {
        fake.set(outcome.retryAt.getTime());
      }
    }

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "retry_scheduled",
      "retry_scheduled",
      "retry_scheduled",
      "failed",
    ]);
    expect(calls).toBe(4);
    expect((await events()).at(-1)).toEqual({
      type: "step_failed",
      stepId: "step-1",
      error: {
        name: "StepScheduleToCloseTimeoutError",
        message: "step did not close within 10000 ms of being scheduled",
        details: { timeoutMs: 10_000 },
        cause: { name: "Error", message: "upstream busy 4" },
      },
    });
    expect(await deadLetters.list()).toEqual([]);
  });

  it("aborts a running attempt at the schedule-to-close deadline and does not retry it", async () => {
    let signal: AbortSignal | undefined;
    steps.set(
      "import",
      defineStep("import", {
        retry: policy,
        timeoutMs: 60_000,
        scheduleToCloseTimeoutMs: 5000,
        handler: (_input, context) => {
          signal = context.signal;
          return new Promise<never>(() => undefined);
        },
      }),
    );
    await enqueueStep(T0 - 2000);
    const processing = processor.process(await lease());
    await waitForTimers(2);
    fake.advance(2999);
    await turn();
    expect(signal?.aborted).toBe(false);
    fake.advance(1);

    expect(await processing).toEqual({ status: "failed", attempt: 1 });
    expect(signal?.reason).toMatchObject({ name: "StepScheduleToCloseTimeoutError" });
    expect((await events()).at(-1)).toMatchObject({
      type: "step_failed",
      error: { name: "StepScheduleToCloseTimeoutError" },
    });
  });

  it("fails a step delivered after its schedule-to-close deadline without running it", async () => {
    let calls = 0;
    steps.set(
      "import",
      defineStep("import", {
        scheduleToCloseTimeoutMs: 5000,
        handler: () => {
          calls += 1;
          return "late";
        },
      }),
    );
    await enqueueStep(T0 - 5000);

    expect(await processor.process(await lease())).toEqual({ status: "failed", attempt: 1 });
    expect(calls).toBe(0);
    expect(await events()).toEqual([
      expect.objectContaining({ type: "step_attempt_failed", retryAt: null }),
      expect.objectContaining({
        type: "step_failed",
        error: expect.objectContaining({ name: "StepScheduleToCloseTimeoutError" }) as unknown,
      }),
    ]);
  });

  it("gives a requeued dead letter a fresh schedule-to-close deadline", async () => {
    steps.set(
      "import",
      defineStep("import", {
        retry: { ...policy, maxAttempts: 1 },
        scheduleToCloseTimeoutMs: 5000,
        handler: () => {
          throw new Error("broken");
        },
      }),
    );
    await enqueueStep();
    expect(await processor.process(await lease())).toMatchObject({ status: "dead_lettered" });
    fake.advance(60_000);
    const [entry] = await deadLetters.list();
    await deadLetters.requeue(entry?.id ?? "");

    const requeued = await lease();
    expect(requeued.payload).toMatchObject({
      scheduledAt: new Date(T0 + 60_000).toISOString(),
      attemptOffset: 1,
    });
  });

  it("ignores heartbeats sent after the attempt ended", async () => {
    let late: StepContext | undefined;
    steps.set(
      "import",
      defineStep("import", {
        handler: (_input, context) => {
          late = context;
          context.heartbeat("first");
          return "ok";
        },
      }),
    );
    await enqueueStep();
    expect(await processor.process(await lease())).toEqual({ status: "completed", attempt: 1 });
    late?.heartbeat("after the end");
    await turn();

    expect(await heartbeats.read(runId, "step-1")).toMatchObject({ details: "first" });
  });
});

describe("heartbeat store", () => {
  let database: IsolatedSchema;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'import-file') returning id",
      [namespace.rows[0]?.id],
    );
    runId = run.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  it("keeps the newest attempt's details when an older attempt writes late", async () => {
    const heartbeats = createHeartbeatStore(database.pool);
    const at = new Date(T0);
    await heartbeats.record({
      runId,
      stepId: "s",
      attempt: 2,
      details: { row: 40 },
      recordedAt: at,
    });
    await heartbeats.record({
      runId,
      stepId: "s",
      attempt: 1,
      details: { row: 9 },
      recordedAt: at,
    });
    await heartbeats.record({
      runId,
      stepId: "s",
      attempt: 2,
      details: { row: 41 },
      recordedAt: at,
    });

    expect(await heartbeats.read(runId, "s")).toEqual({
      attempt: 2,
      details: { row: 41 },
      recordedAt: at,
    });
    expect(await heartbeats.read(runId, "other")).toBeUndefined();
  });

  it("is removed with its run", async () => {
    const heartbeats = createHeartbeatStore(database.pool);
    await heartbeats.record({
      runId,
      stepId: "gone",
      attempt: 1,
      details: null,
      recordedAt: new Date(T0),
    });
    await database.pool.query("delete from workflow_runs where id = $1", [runId]);

    const rows = await database.pool.query("select 1 from step_heartbeats where run_id = $1", [
      runId,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});
