import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import { createTaskQueue, type TaskQueue } from "../queue/task-queue.js";
import { commandToEvent } from "../workflow/command-events.js";
import type { WorkflowHandler } from "../workflow/context.js";
import type { ClockSource } from "../workflow/sources.js";
import { createRunCache } from "./run-cache.js";
import { createStickyDecider, type StickyDecider } from "./sticky-decider.js";
import { createStickyRouter, type StickyRouter } from "./sticky-router.js";
import type { LiveSession } from "../workflow/live-session.js";

interface FakeClock extends ClockSource {
  advance(ms: number): void;
}

function createFakeClock(start: Date): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const QUEUE = "default";
const STICKY_TIMEOUT_MS = 10_000;

const chain: WorkflowHandler<{ steps: number }, number> = async (ctx, input) => {
  let total = 0;
  for (let index = 0; index < input.steps; index += 1) {
    total += await ctx.step<number>("add", { index });
  }
  return total;
};

describe("sticky routing against postgres", () => {
  let database: IsolatedSchema;
  let clock: FakeClock;
  let queue: TaskQueue;
  let router: StickyRouter;
  let store: EventStore;
  let recorder: ResultRecorder;
  let namespaceId: string;
  let runIds: string[];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from run_stickiness");
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
    clock = createFakeClock(new Date("2026-01-01T00:00:00Z"));
    queue = createTaskQueue(database.pool, { clock });
    router = createStickyRouter(database.pool, { clock });
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: QUEUE });
    runIds = [];
  });

  async function startRun(input: unknown): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, input) values ($1, 'chain', $2::jsonb) returning id",
      [namespaceId, JSON.stringify(input)],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "chain", input }]);
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: QUEUE,
      taskType: "WORKFLOW_TASK",
      payload: { reason: "start" },
    });
    runIds.push(runId);
    return runId;
  }

  interface TestWorker {
    readonly id: string;
    readonly decider: StickyDecider;
    readonly handled: string[];
  }

  function createTestWorker(id: string): TestWorker {
    return {
      id,
      handled: [],
      decider: createStickyDecider({
        cache: createRunCache<LiveSession>({
          maxRuns: 8,
          stickyTimeoutMs: STICKY_TIMEOUT_MS,
          clock,
        }),
        decisionOptions: {
          clock,
          random: { random: () => 0.5, uuid: () => "fixed-uuid" },
        },
      }),
    };
  }

  async function workOnce(worker: TestWorker): Promise<boolean> {
    const [task] = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 30_000,
      workerId: worker.id,
      stickyFor: worker.id,
    });
    if (task === undefined) {
      return false;
    }
    if (task.taskType === "STEP_TASK") {
      const payload = task.payload as { stepId: string; input: { index: number } };
      await recorder.recordStepResult({
        runId: task.runId,
        stepId: payload.stepId,
        attemptKey: "1",
        outcome: { status: "completed", result: payload.input.index },
      });
      await queue.enqueue({
        namespaceId,
        runId: task.runId,
        queueName: QUEUE,
        taskType: "WORKFLOW_TASK",
        payload: { reason: "step_completed" },
      });
      await queue.ack(task.id, task.leaseToken);
      return true;
    }
    const events = (await store.read(task.runId)).map((stored) => stored.event);
    const { decision } = await worker.decider.decide(task.runId, chain, { steps: 6 }, events);
    await recorder.recordWorkflowTaskResult({
      runId: task.runId,
      taskKey: task.id,
      expectedSeq: events.length,
      events: decision.commands.map(commandToEvent),
    });
    for (const command of decision.commands) {
      if (command.type === "schedule_step") {
        await queue.enqueue({
          namespaceId,
          runId: task.runId,
          queueName: QUEUE,
          taskType: "STEP_TASK",
          payload: { stepId: command.stepId, input: command.input },
        });
      }
    }
    if (decision.outcome === "suspended") {
      await router.claim(task.runId, worker.id, STICKY_TIMEOUT_MS);
    }
    worker.handled.push(task.runId);
    await queue.ack(task.id, task.leaseToken);
    return true;
  }

  async function runStatus(runId: string): Promise<string> {
    const row = await database.pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0]?.status ?? "";
  }

  it("claims a run for one worker and refuses to steal a live claim", async () => {
    const runId = await startRun({ steps: 6 });
    const first = await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    const second = await router.claim(runId, "worker-b", STICKY_TIMEOUT_MS);
    expect(first.workerId).toBe("worker-a");
    expect(second.workerId).toBe("worker-a");
    expect(second.expiresAt).toEqual(first.expiresAt);
  });

  it("lets another worker take a claim over once it has expired", async () => {
    const runId = await startRun({ steps: 6 });
    await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    clock.advance(STICKY_TIMEOUT_MS + 1);
    expect(await router.find(runId)).toBeUndefined();
    const taken = await router.claim(runId, "worker-b", STICKY_TIMEOUT_MS);
    expect(taken.workerId).toBe("worker-b");
  });

  it("extends the claim each time the same worker claims again", async () => {
    const runId = await startRun({ steps: 6 });
    await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    clock.advance(6000);
    const renewed = await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    expect(renewed.expiresAt.getTime()).toBe(clock.now().getTime() + STICKY_TIMEOUT_MS);
  });

  it("hands a sticky run's tasks only to the claiming worker", async () => {
    const runId = await startRun({ steps: 6 });
    await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    const forB = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 1000,
      stickyFor: "worker-b",
    });
    expect(forB).toEqual([]);
    const forA = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 1000,
      stickyFor: "worker-a",
    });
    expect(forA).toHaveLength(1);
  });

  it("never holds back a step task for a sticky claim", async () => {
    const runId = await startRun({ steps: 6 });
    await queue.enqueue({
      namespaceId,
      runId,
      queueName: QUEUE,
      taskType: "STEP_TASK",
      payload: { stepId: "step-1" },
    });
    await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    const forB = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 1000,
      limit: 5,
      stickyFor: "worker-b",
    });
    expect(forB.map((task) => task.taskType)).toEqual(["STEP_TASK"]);
  });

  it("falls back to any worker once the sticky timeout has passed", async () => {
    const runId = await startRun({ steps: 6 });
    await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    clock.advance(STICKY_TIMEOUT_MS + 1);
    const forB = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 1000,
      stickyFor: "worker-b",
    });
    expect(forB).toHaveLength(1);
  });

  it("ignores stickiness for a consumer that does not ask for it", async () => {
    const runId = await startRun({ steps: 6 });
    await router.claim(runId, "worker-a", STICKY_TIMEOUT_MS);
    const plain = await queue.dequeue({ queueName: QUEUE, visibilityTimeoutMs: 1000 });
    expect(plain).toHaveLength(1);
  });

  it("releases a worker's claims when it shuts down", async () => {
    const first = await startRun({ steps: 6 });
    const second = await startRun({ steps: 6 });
    await router.claim(first, "worker-a", STICKY_TIMEOUT_MS);
    await router.claim(second, "worker-a", STICKY_TIMEOUT_MS);
    expect(await router.releaseWorker("worker-a")).toBe(2);
    expect(await router.find(first)).toBeUndefined();
    expect(await router.release(second, "worker-a")).toBe(false);
  });

  it("keeps a run on one worker while two workers poll, and serves it from the cache", async () => {
    const runId = await startRun({ steps: 6 });
    const workerA = createTestWorker("worker-a");
    const workerB = createTestWorker("worker-b");
    for (let round = 0; round < 40; round += 1) {
      const worked = [await workOnce(workerA), await workOnce(workerB)];
      if (!worked.includes(true)) {
        break;
      }
    }
    expect(await runStatus(runId)).toBe("COMPLETED");
    const handledBy = [workerA, workerB].filter((worker) => worker.handled.length > 0);
    expect(handledBy).toHaveLength(1);
    const owner = handledBy[0];
    expect(owner?.handled).toHaveLength(7);
    expect(owner?.decider.stats().fullReplays).toBe(1);
    expect(owner?.decider.stats().cacheHits).toBe(6);
  });

  it("completes with the same result when the owning worker disappears mid-run", async () => {
    const runId = await startRun({ steps: 6 });
    const workerA = createTestWorker("worker-a");
    const workerB = createTestWorker("worker-b");
    for (let turn = 0; turn < 5; turn += 1) {
      await workOnce(workerA);
    }
    expect(workerA.handled.length).toBeGreaterThan(0);
    expect(await runStatus(runId)).toBe("RUNNING");
    await workOnce(workerB);
    expect(workerB.handled).toEqual([]);
    clock.advance(STICKY_TIMEOUT_MS + 1);
    for (let turn = 0; turn < 40; turn += 1) {
      if (!(await workOnce(workerB))) {
        break;
      }
    }
    expect(await runStatus(runId)).toBe("COMPLETED");
    expect(workerB.decider.stats().fullReplays).toBe(1);
    const result = await database.pool.query<{ result: number }>(
      "select result from workflow_runs where id = $1",
      [runId],
    );
    expect(result.rows[0]?.result).toBe(15);
  });
});
