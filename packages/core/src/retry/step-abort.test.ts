import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createResultRecorder } from "../idempotency/recorder.js";
import { createTaskQueue, type LeasedTask, type TaskQueue } from "../queue/task-queue.js";
import { defineStep, type StepDefinition } from "../workflow/define-step.js";
import { createAttemptLog } from "./attempt-log.js";
import { createDeadLetterQueue } from "./dead-letters.js";
import { StepTimeoutError } from "./timeout.js";
import { createStepTaskProcessor, type StepTaskProcessor } from "./step-task-processor.js";

const QUEUE = "default/steps";
const clock = { now: () => new Date("2026-03-01T10:00:00.000Z") };

function manualTimers() {
  const callbacks: (() => void)[] = [];
  return {
    timers: {
      setTimeout(callback: () => void): unknown {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimeout(): void {
        return;
      },
    },
    fireAll(): void {
      callbacks.splice(0).forEach((callback) => {
        callback();
      });
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    });
  });
}

describe("step abort signal", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let runId: string;
  let queue: TaskQueue;
  let processor: StepTaskProcessor;
  let steps: Map<string, StepDefinition>;
  let timers: ReturnType<typeof manualTimers>;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate workflow_runs cascade");
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
    steps = new Map();
    timers = manualTimers();
    queue = createTaskQueue(database.pool, { clock });
    processor = createStepTaskProcessor({
      pool: database.pool,
      queue,
      recorder: createResultRecorder(database.pool),
      attempts: createAttemptLog(database.pool),
      deadLetters: createDeadLetterQueue(database.pool, { clock }),
      lookup: (stepType) => steps.get(stepType),
      clock,
      random: { random: () => 0.5, uuid: () => "id" },
      timers: timers.timers,
    });
  });

  async function leaseStep(): Promise<LeasedTask> {
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: QUEUE,
      taskType: "STEP_TASK",
      payload: { stepId: "charge-card", stepType: "charge", input: {} },
    });
    const [task] = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 30_000 });
    if (task === undefined) {
      throw new Error("no task was visible");
    }
    return task;
  }

  async function count(table: string): Promise<number> {
    const result = await database.pool.query<{ count: string }>(`select count(*) from ${table}`);
    return Number(result.rows[0]?.count);
  }

  it("hands the step an abort signal that fires when the lease is lost", async () => {
    let seen: AbortSignal | undefined;
    const started = deferred();
    steps.set(
      "charge",
      defineStep("charge", {
        handler: async (_input, { signal }) => {
          seen = signal;
          started.resolve();
          return untilAborted(signal);
        },
      }),
    );
    const task = await leaseStep();
    const lease = new AbortController();

    const processing = processor.process(task, { signal: lease.signal });
    await started.promise;
    expect(seen?.aborted).toBe(false);
    lease.abort(new Error("lease lost"));

    expect(await processing).toEqual({ status: "lease_lost" });
    expect(seen?.aborted).toBe(true);
  });

  it("records nothing and settles nothing for a delivery whose lease was lost", async () => {
    const started = deferred();
    steps.set(
      "charge",
      defineStep("charge", {
        handler: (_input, { signal }) => {
          started.resolve();
          return untilAborted(signal);
        },
      }),
    );
    const task = await leaseStep();
    const lease = new AbortController();

    const processing = processor.process(task, { signal: lease.signal });
    await started.promise;
    lease.abort(new Error("lease lost"));
    await processing;

    expect(await count("step_attempts")).toBe(0);
    expect(await count("step_results")).toBe(0);
    const state = await database.pool.query<{ state: string }>("select state from tasks");
    expect(state.rows[0]?.state).toBe("LEASED");
  });

  it("stops waiting for a step that ignores the signal once its lease is lost", async () => {
    const started = deferred();
    steps.set(
      "charge",
      defineStep("charge", {
        handler: () => {
          started.resolve();
          return new Promise<never>(() => undefined);
        },
      }),
    );
    const task = await leaseStep();
    const lease = new AbortController();

    const processing = processor.process(task, { signal: lease.signal });
    await started.promise;
    lease.abort(new Error("lease lost"));

    expect(await processing).toEqual({ status: "lease_lost" });
  });

  it("does not run a step for a delivery that arrives already aborted", async () => {
    let ran = false;
    steps.set(
      "charge",
      defineStep("charge", {
        handler: () => {
          ran = true;
          return 1;
        },
      }),
    );
    const task = await leaseStep();

    const outcome = await processor.process(task, { signal: AbortSignal.abort(new Error("gone")) });

    expect(outcome).toEqual({ status: "lease_lost" });
    expect(ran).toBe(false);
  });

  it("aborts the signal the step sees when its own timeout elapses", async () => {
    let reason: unknown;
    const started = deferred();
    steps.set(
      "charge",
      defineStep("charge", {
        timeoutMs: 5000,
        handler: async (_input, { signal }) => {
          started.resolve();
          try {
            await untilAborted(signal);
          } catch (error) {
            reason = error;
            throw error;
          }
        },
      }),
    );
    const task = await leaseStep();

    const processing = processor.process(task, { signal: new AbortController().signal });
    await started.promise;
    timers.fireAll();
    const outcome = await processing;

    expect(reason).toBeInstanceOf(StepTimeoutError);
    expect(outcome.status).toBe("retry_scheduled");
  });

  it("still completes a step normally when the lease holds", async () => {
    steps.set("charge", defineStep("charge", { handler: () => ({ charged: true }) }));
    const task = await leaseStep();

    const outcome = await processor.process(task, { signal: new AbortController().signal });

    expect(outcome.status).toBe("completed");
    expect(await count("step_results")).toBe(1);
  });
});
