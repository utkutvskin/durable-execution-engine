import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTaskQueue,
  defineStep,
  defineWorkflow,
  type LeasedTask,
  type Pool,
  type TaskQueue,
} from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createVirtualTime, waitFor, type VirtualTime } from "../test-support.ts";
import { createWorker } from "../worker.ts";
import { createEngineTaskHandler, type AnyWorkflowDefinition } from "./task-handler.ts";

const signal = new AbortController().signal;

describe("poison tasks and waiting runs against postgres", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let namespaceId: string;
  let service: RunService;
  let time: VirtualTime;
  let queue: TaskQueue;

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
    time = createVirtualTime(new Date(Date.now() + 3_600_000));
    queue = createTaskQueue(pool, { clock: time.clock });
  });

  async function startRun(workflowType: string): Promise<string> {
    const started = await service.startRun(namespaceId, { workflowType });
    return started.run.runId;
  }

  async function leaseNext(): Promise<LeasedTask> {
    const [task] = await queue.dequeue({ queueName: "default", visibilityTimeoutMs: 30_000 });
    if (task === undefined) {
      throw new Error("no task to lease");
    }
    return task;
  }

  function handlerFor(workflows: readonly AnyWorkflowDefinition[]) {
    return createEngineTaskHandler({
      pool,
      queue,
      queueName: "default",
      workflows,
      steps: [defineStep<unknown, string>("a", { handler: () => "a" })],
      clock: time.clock,
    });
  }

  async function waitingOn(runId: string): Promise<string | null> {
    const result = await pool.query<{ waiting_on: string | null }>(
      "select waiting_on from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.waiting_on ?? null;
  }

  async function taskRow(taskId: string): Promise<{ state: string; reason: string | null }> {
    const result = await pool.query<{ state: string; reason: string | null }>(
      "select state, quarantine_reason as reason from tasks where id = $1",
      [taskId],
    );
    return result.rows[0] ?? { state: "missing", reason: null };
  }

  it("quarantines the task of a run whose code no longer matches its history", async () => {
    const original = defineWorkflow("drifting", async (ctx) => ctx.step("a", {}));
    const changed = defineWorkflow("drifting", async (ctx) => ctx.step("b", {}));
    const runId = await startRun("drifting");
    await handlerFor([original])(await leaseNext(), { signal });
    const redecide = await queue.enqueue({
      namespaceId,
      runId,
      queueName: "default",
      taskType: "WORKFLOW_TASK",
    });
    const stale = await pool.query("update tasks set state = 'COMPLETED' where id <> $1", [
      redecide,
    ]);
    expect(stale.rowCount).toBeGreaterThan(0);
    const worker = createWorker({
      queue,
      queueName: "default",
      handler: handlerFor([changed]),
      timers: time.timers,
    });
    worker.start();
    await waitFor(async () => (await taskRow(redecide)).state === "QUARANTINED");
    expect((await taskRow(redecide)).reason).toContain("NonDeterminismError");
    await worker.stop();
  });

  it("quarantines the task of a workflow type no worker knows, without failing the run", async () => {
    const runId = await startRun("mystery");
    const first = await leaseNext();
    const worker = createWorker({
      queue,
      queueName: "default",
      handler: handlerFor([]),
      timers: time.timers,
    });
    await queue.nack(first.id, first.leaseToken);
    worker.start();
    await waitFor(async () => (await taskRow(first.id)).state === "QUARANTINED");
    expect((await taskRow(first.id)).reason).toContain("UnknownWorkflowError");
    const run = await pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    expect(run.rows[0]?.status).toBe("RUNNING");
    await worker.stop();
  });

  it("retries a handler that always throws with doubling delays and quarantines it", async () => {
    await startRun("anything");
    const queued = await pool.query<{ id: string }>("select id from tasks");
    const task = { id: queued.rows[0]?.id ?? "" };
    let calls = 0;
    const worker = createWorker({
      queue,
      queueName: "default",
      handler: () => {
        calls += 1;
        return Promise.reject(new Error("always"));
      },
      timers: time.timers,
      pollIntervalMs: 100,
      nackBackoff: { initialMs: 1000, maxMs: 8000 },
      maxHandlerAttempts: 5,
    });
    worker.start();
    const delays: number[] = [];
    for (let delivery = 1; delivery <= 4; delivery += 1) {
      await waitFor(async () => calls === delivery && (await taskRow(task.id)).state === "PENDING");
      await waitFor(() => time.pendingDelays().length > 0);
      const visible = await pool.query<{ visible_at: Date }>(
        "select visible_at from tasks where id = $1",
        [task.id],
      );
      delays.push((visible.rows[0]?.visible_at.getTime() ?? 0) - time.clock.now().getTime());
      time.advance(10_000);
    }
    await waitFor(async () => (await taskRow(task.id)).state === "QUARANTINED");
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(calls).toBe(5);
    expect((await taskRow(task.id)).reason).toBe("handler failed 5 times: always");
    await worker.stop();
  });

  it("marks a run that waits on a signal and clears the wait when the signal arrives", async () => {
    const flow = defineWorkflow("approval", async (ctx) => ctx.waitForSignal<string>("go"));
    const handler = handlerFor([flow]);
    const runId = await startRun("approval");
    await handler(await leaseNext(), { signal });
    expect(await waitingOn(runId)).toBe("external");
    await service.signalRun(namespaceId, runId, "go", "now");
    await handler(await leaseNext(), { signal });
    expect(await waitingOn(runId)).toBeNull();
  });

  it("does not mark a run that waits on a step it still has to run", async () => {
    const flow = defineWorkflow("stepper", async (ctx) => ctx.step("a", {}));
    const runId = await startRun("stepper");
    await handlerFor([flow])(await leaseNext(), { signal });
    expect(await waitingOn(runId)).toBeNull();
  });

  it("marks a run whose only open step was dead-lettered", async () => {
    const flow = defineWorkflow("stepper", async (ctx) => ctx.step("a", {}));
    const runId = await startRun("stepper");
    const handler = handlerFor([flow]);
    await handler(await leaseNext(), { signal });
    await pool.query(
      `insert into dead_letters (namespace_id, run_id, step_id, queue_name, attempts, error, reason)
       select namespace_id, id, 'step-0', 'default', 3, '{}'::jsonb, 'MAX_ATTEMPTS_EXHAUSTED'
       from workflow_runs where id = $1`,
      [runId],
    );
    const stepId = await pool.query<{ step_id: string }>(
      "select payload ->> 'stepId' as step_id from run_events where run_id = $1 and payload ->> 'type' = 'step_scheduled'",
      [runId],
    );
    await pool.query("update dead_letters set step_id = $2 where run_id = $1", [
      runId,
      stepId.rows[0]?.step_id,
    ]);
    await pool.query("update tasks set state = 'COMPLETED'");
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: "default",
      taskType: "WORKFLOW_TASK",
    });
    await handler(await leaseNext(), { signal });
    expect(await waitingOn(runId)).toBe("dead_letter");
  });
});
