import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createPostgresEventStore } from "../event-store/event-store.js";
import { createResultRecorder } from "../idempotency/recorder.js";
import { createTaskQueue } from "../queue/task-queue.js";
import { runDecisionLoop } from "../workflow/decision-loop.js";
import { createTimerScheduler } from "./timer-scheduler.js";

const QUEUE = "default/workflows";
const START = new Date("2026-03-01T10:00:00.000Z");

describe("timer scheduler", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let now = START;
  const clock = { now: () => now };

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
    await database.pool.query("delete from timers");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    now = START;
  });

  async function createRun(status = "RUNNING"): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, status) values ($1, 'sleeper', $2) returning id",
      [namespaceId, status],
    );
    return run.rows[0]?.id ?? "";
  }

  function at(offsetMs: number): Date {
    return new Date(START.getTime() + offsetMs);
  }

  function scheduler(batchSize?: number) {
    return createTimerScheduler(database.pool, {
      queueName: QUEUE,
      clock,
      ...(batchSize === undefined ? {} : { batchSize }),
    });
  }

  it("schedules a timer once per run and timer id", async () => {
    const runId = await createRun();
    const timers = scheduler();
    expect(await timers.schedule({ runId, timerId: "timer-1", fireAt: at(1000) })).toBe(true);
    expect(await timers.schedule({ runId, timerId: "timer-1", fireAt: at(9000) })).toBe(false);
    const rows = await database.pool.query("select fire_at from timers where run_id = $1", [runId]);
    expect(rows.rows).toHaveLength(1);
    expect(await timers.nextDueAt()).toEqual(at(1000));
  });

  it("does not fire a timer one millisecond early and fires it exactly when due", async () => {
    const runId = await createRun();
    const timers = scheduler();
    await timers.schedule({ runId, timerId: "timer-1", fireAt: at(5000) });

    now = at(4999);
    expect((await timers.tick()).fired).toHaveLength(0);

    now = at(5000);
    const report = await timers.tick();
    expect(report.fired).toHaveLength(1);
    expect(report.fired[0]).toMatchObject({ runId, timerId: "timer-1", lateMs: 0 });

    const events = await createPostgresEventStore(database.pool).read(runId);
    expect(events.map((stored) => stored.event)).toEqual([
      { type: "timer_fired", timerId: "timer-1" },
    ]);
    const tasks = await database.pool.query(
      "select task_type, queue_name, payload from tasks where run_id = $1",
      [runId],
    );
    expect(tasks.rows).toEqual([
      {
        task_type: "WORKFLOW_TASK",
        queue_name: QUEUE,
        payload: { reason: "timer_fired", timerId: "timer-1" },
      },
    ]);
  });

  it("fires a timer only once however many ticks follow", async () => {
    const runId = await createRun();
    const timers = scheduler();
    await timers.schedule({ runId, timerId: "timer-1", fireAt: at(1000) });
    now = at(60_000);
    await timers.tick();
    expect((await timers.tick()).fired).toHaveLength(0);
    expect((await timers.catchUp()).fired).toHaveLength(0);
    const events = await createPostgresEventStore(database.pool).read(runId);
    expect(events).toHaveLength(1);
    expect(await timers.nextDueAt()).toBeUndefined();
  });

  it("advances a run past a 10 minute sleep after a full restart", async () => {
    const runId = await createRun();
    const store = createPostgresEventStore(database.pool);
    const recorder = createResultRecorder(database.pool);
    const handler = async (ctx: { sleep(ms: number): Promise<void> }): Promise<string> => {
      await ctx.sleep(600_000);
      return "woke";
    };
    const decisionOptions = {
      clock,
      random: { random: () => 0.5, uuid: () => "00000000-0000-4000-8000-000000000000" },
    };

    const first = await runDecisionLoop(handler, undefined, [], decisionOptions);
    expect(first.outcome).toBe("suspended");
    if (first.outcome !== "suspended") {
      throw new Error("expected a suspended decision");
    }
    const started = first.commands.flatMap((command) =>
      command.type === "start_timer"
        ? [{ type: "timer_started" as const, timerId: command.timerId, fireAt: command.fireAt }]
        : [],
    );
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "task-1",
      expectedSeq: 0,
      events: started,
    });

    const beforeShutdown = scheduler();
    now = at(599_999);
    expect((await beforeShutdown.tick()).fired).toHaveLength(0);

    now = at(600_000);
    const afterRestart = scheduler();
    const report = await afterRestart.catchUp();
    expect(report.fired).toHaveLength(1);
    expect(report.fired[0]?.lateMs).toBe(0);

    const history = (await store.read(runId)).map((stored) => stored.event);
    const second = await runDecisionLoop(handler, undefined, history, decisionOptions);
    expect(second).toMatchObject({ outcome: "completed", result: "woke" });
  });

  it("catches up on timers that came due while the engine was down, however late", async () => {
    const runId = await createRun();
    const timers = scheduler();
    await timers.schedule({ runId, timerId: "timer-1", fireAt: at(600_000) });
    now = at(600_000 + 3_600_000);
    const report = await scheduler().catchUp();
    expect(report.fired).toHaveLength(1);
    expect(report.fired[0]?.lateMs).toBe(3_600_000);
  });

  it("processes 500 overdue timers in fire order and delivers their tasks in that order", async () => {
    const runIds: string[] = [];
    const expectedOrder: string[] = [];
    const offsets = Array.from({ length: 500 }, (_, index) => (index * 7919) % 500);
    for (const offset of offsets) {
      const runId = await createRun();
      runIds.push(runId);
      await database.pool.query(
        "insert into timers (run_id, timer_id, fire_at) values ($1, 'timer-1', $2)",
        [runId, at(offset * 1000)],
      );
      expectedOrder[offset] = runId;
    }

    now = at(10_000_000);
    const report = await scheduler(64).catchUp();

    expect(report.fired).toHaveLength(500);
    expect(report.ticks).toBe(8);
    expect(report.fired.map((fired) => fired.runId)).toEqual(expectedOrder);

    const queue = createTaskQueue(database.pool, { clock });
    const delivered = await queue.dequeue({
      queueName: QUEUE,
      visibilityTimeoutMs: 60_000,
      limit: 500,
    });
    expect(delivered.map((task) => task.runId)).toEqual(expectedOrder);
    const events = await database.pool.query<{ count: string }>(
      "select count(*) from run_events where event_type = 'timer_fired'",
    );
    expect(Number(events.rows[0]?.count)).toBe(500);
  });

  it("respects the batch size on a tick", async () => {
    for (let index = 0; index < 5; index += 1) {
      const runId = await createRun();
      await scheduler().schedule({ runId, timerId: "timer-1", fireAt: at(index) });
    }
    now = at(1000);
    const timers = scheduler(2);
    expect((await timers.tick()).fired).toHaveLength(2);
    expect((await timers.catchUp()).fired).toHaveLength(3);
  });

  it("closes a due timer of a finished run without an event or a task", async () => {
    const runId = await createRun("COMPLETED");
    const timers = scheduler();
    await timers.schedule({ runId, timerId: "timer-1", fireAt: at(1000) });
    now = at(2000);
    const report = await timers.tick();
    expect(report).toMatchObject({ fired: [], cancelled: 1 });
    const state = await database.pool.query<{ state: string }>(
      "select state from timers where run_id = $1",
      [runId],
    );
    expect(state.rows[0]?.state).toBe("CANCELLED");
    expect((await database.pool.query("select 1 from tasks")).rowCount).toBe(0);
    expect((await database.pool.query("select 1 from run_events")).rowCount).toBe(0);
  });

  it("lets two schedulers race over the same timers without firing any twice", async () => {
    for (let index = 0; index < 40; index += 1) {
      const runId = await createRun();
      await scheduler().schedule({ runId, timerId: "timer-1", fireAt: at(index) });
    }
    now = at(1000);
    const [first, second] = await Promise.all([scheduler(10).catchUp(), scheduler(10).catchUp()]);
    expect(first.fired.length + second.fired.length).toBe(40);
    const events = await database.pool.query<{ count: string }>(
      "select count(*) from run_events where event_type = 'timer_fired'",
    );
    expect(Number(events.rows[0]?.count)).toBe(40);
    const tasks = await database.pool.query<{ count: string }>("select count(*) from tasks");
    expect(Number(tasks.rows[0]?.count)).toBe(40);
  });

  it("does not fire early or twice when the wall clock steps backwards", async () => {
    const runIdA = await createRun();
    const runIdB = await createRun();
    const timers = scheduler();
    await timers.schedule({ runId: runIdA, timerId: "timer-1", fireAt: at(1000) });
    await timers.schedule({ runId: runIdB, timerId: "timer-1", fireAt: at(3000) });

    now = at(2000);
    expect((await timers.tick()).fired.map((fired) => fired.runId)).toEqual([runIdA]);

    now = at(500);
    expect((await timers.tick()).fired).toHaveLength(0);
    expect(timers.clockRegressions).toBe(1);

    now = at(3000);
    expect((await timers.tick()).fired.map((fired) => fired.runId)).toEqual([runIdB]);
  });

  it("rejects a non-positive batch size", () => {
    expect(() => scheduler(0)).toThrow(RangeError);
  });

  it("creates the timer row in the same transaction as the timer_started event", async () => {
    const runId = await createRun();
    const recorder = createResultRecorder(database.pool);
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: "task-1",
      expectedSeq: 0,
      events: [{ type: "timer_started", timerId: "timer-1", fireAt: at(1000).toISOString() }],
    });
    const stored = await database.pool.query<{ timer_id: string; state: string }>(
      "select timer_id, state from timers where run_id = $1",
      [runId],
    );
    expect(stored.rows).toEqual([{ timer_id: "timer-1", state: "PENDING" }]);

    await expect(
      recorder.recordWorkflowTaskResult({
        runId,
        taskKey: "task-2",
        expectedSeq: 0,
        events: [{ type: "timer_started", timerId: "timer-2", fireAt: at(2000).toISOString() }],
      }),
    ).rejects.toThrow();
    const after = await database.pool.query("select 1 from timers where run_id = $1", [runId]);
    expect(after.rowCount).toBe(1);
  });

  it("does not create a second timer when the same workflow task is delivered twice", async () => {
    const runId = await createRun();
    const recorder = createResultRecorder(database.pool);
    const input = {
      runId,
      taskKey: "task-1",
      expectedSeq: 0,
      events: [
        {
          type: "timer_started" as const,
          timerId: "timer-1",
          fireAt: at(1000).toISOString(),
        },
      ],
    };
    await recorder.recordWorkflowTaskResult(input);
    const repeat = await recorder.recordWorkflowTaskResult(input);
    expect(repeat.recorded).toBe(false);
    expect((await database.pool.query("select 1 from timers")).rowCount).toBe(1);
  });

  it("refuses a state outside pending, fired and cancelled and a duplicate timer id", async () => {
    const runId = await createRun();
    await expect(
      database.pool.query(
        "insert into timers (run_id, timer_id, fire_at, state) values ($1, 'x', now(), 'LOST')",
        [runId],
      ),
    ).rejects.toThrow();
    await database.pool.query(
      "insert into timers (run_id, timer_id, fire_at) values ($1, 'x', now())",
      [runId],
    );
    await expect(
      database.pool.query(
        "insert into timers (run_id, timer_id, fire_at) values ($1, 'x', now())",
        [runId],
      ),
    ).rejects.toThrow();
  });
});
