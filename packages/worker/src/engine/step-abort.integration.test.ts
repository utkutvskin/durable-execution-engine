import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTaskQueue, defineStep, type Pool, type TaskQueue } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { LeaseLostError } from "../errors.ts";
import { createDeferred, createVirtualTime, waitFor, type VirtualTime } from "../test-support.ts";
import { createWorker } from "../worker.ts";
import { createEngineTaskHandler } from "./task-handler.ts";

describe("a hanging step that loses its lease", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let namespaceId: string;
  let time: VirtualTime;
  let queue: TaskQueue;
  let runId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
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
    time = createVirtualTime(new Date(Date.now() + 3_600_000));
    queue = createTaskQueue(pool, { clock: time.clock });
    const run = await pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, queue_name) values ($1, 'hang', 'default') returning id",
      [namespaceId],
    );
    runId = run.rows[0]?.id ?? "";
    await pool.query(
      `insert into run_events (run_id, sequence_number, event_type, payload)
       values ($1, 1, 'run_started', '{"type":"run_started","workflowType":"hang","input":{}}'::jsonb),
              ($1, 2, 'step_scheduled',
               '{"type":"step_scheduled","stepId":"step-1","stepType":"hang","input":{}}'::jsonb)`,
      [runId],
    );
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: "default",
      taskType: "STEP_TASK",
      payload: { stepId: "step-1", stepType: "hang", input: {} },
    });
  });

  function trackedStep() {
    const tracker = { active: 0, maxActive: 0, started: 0, abortReasons: [] as unknown[] };
    const release = createDeferred();
    const definition = defineStep<unknown, string>("hang", {
      handler: async (_input, { signal }) => {
        tracker.active += 1;
        tracker.started += 1;
        tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
        signal.addEventListener("abort", () => {
          tracker.abortReasons.push(signal.reason);
        });
        const aborted = new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
        try {
          await Promise.race([release.promise, aborted]);
          return "done";
        } finally {
          tracker.active -= 1;
        }
      },
    });
    return { tracker, release, definition };
  }

  function engineHandler(definition: ReturnType<typeof trackedStep>["definition"]) {
    return createEngineTaskHandler({
      pool,
      queue,
      queueName: "default",
      workflows: [],
      steps: [definition],
      clock: time.clock,
    });
  }

  it("aborts the step when another consumer took the lease", async () => {
    const { tracker, definition } = trackedStep();
    const worker = createWorker({
      queue,
      queueName: "default",
      handler: engineHandler(definition),
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
      timers: time.timers,
      clock: time.clock,
    });
    worker.start();
    await waitFor(() => tracker.active === 1);

    await pool.query("update tasks set lease_token = gen_random_uuid()");
    time.advance(10_000);
    await waitFor(() => worker.activeCount === 0);

    expect(tracker.abortReasons).toHaveLength(1);
    expect(tracker.abortReasons[0]).toBeInstanceOf(LeaseLostError);
    expect(tracker.active).toBe(0);
    await worker.stop();
  });

  it("never runs the step twice at the same time across the lease loss", async () => {
    const { tracker, release, definition } = trackedStep();
    const handler = engineHandler(definition);
    const worker = createWorker({
      queue,
      queueName: "default",
      handler,
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
      timers: time.timers,
      clock: time.clock,
    });
    worker.start();
    await waitFor(() => tracker.active === 1);
    await pool.query(
      `update tasks set state = 'PENDING', lease_token = null, visible_at = $1
       where state = 'LEASED'`,
      [time.clock.now()],
    );
    const [second] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    time.advance(10_000);
    await waitFor(() => tracker.active === 0);

    release.resolve();
    await handler(second ?? failNoTask(), { signal: new AbortController().signal });

    expect(tracker.started).toBe(2);
    expect(tracker.maxActive).toBe(1);
    const results = await pool.query("select 1 from step_results where run_id = $1", [runId]);
    expect(results.rowCount).toBe(1);
    await worker.stop();
  });

  it("aborts the step and leaves the task to its next delivery when the worker is dropped", async () => {
    const { tracker, definition } = trackedStep();
    const worker = createWorker({
      queue,
      queueName: "default",
      handler: engineHandler(definition),
      shutdownTimeoutMs: 1000,
      timers: time.timers,
      clock: time.clock,
    });
    worker.start();
    await waitFor(() => tracker.active === 1);

    const stopped = worker.stop();
    await waitFor(() => time.pendingDelays().includes(1000));
    time.advance(1000);

    expect(await stopped).toEqual({ completed: 0, dropped: 1 });
    expect(tracker.active).toBe(0);
    const task = await pool.query<{ state: string }>("select state from tasks");
    expect(task.rows[0]?.state).toBe("PENDING");
    const attempts = await pool.query("select 1 from step_attempts where run_id = $1", [runId]);
    expect(attempts.rowCount).toBe(0);
  });
});

function failNoTask(): never {
  throw new Error("no task to lease");
}
