import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { InvalidScheduleError } from "./cron.js";
import {
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  createScheduleManager,
  type CreateScheduleInput,
} from "./schedule-manager.js";

const QUEUE = "default/workflows";
const START = new Date("2026-03-01T10:00:00.000Z");
const MINUTE = 60_000;

describe("schedule manager", () => {
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
    await database.pool.query("delete from schedule_triggers");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from schedules");
    now = START;
  });

  function manager(batchSize?: number) {
    return createScheduleManager(database.pool, {
      queueName: QUEUE,
      clock,
      ...(batchSize === undefined ? {} : { batchSize }),
    });
  }

  function definition(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
    return {
      namespaceId,
      name: "every-five",
      cronExpression: "*/5 * * * *",
      workflowType: "report",
      input: { kind: "nightly" },
      ...overrides,
    };
  }

  async function runCount(scheduleId: string): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      "select count(*) from workflow_runs where schedule_id = $1",
      [scheduleId],
    );
    return Number(result.rows[0]?.count);
  }

  async function finishRuns(scheduleId: string): Promise<void> {
    await database.pool.query(
      "update workflow_runs set status = 'COMPLETED', closed_at = now() where schedule_id = $1",
      [scheduleId],
    );
  }

  it("starts exactly 12 runs of a */5 schedule when the clock advances one hour", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "allow_all" }));
    now = new Date(START.getTime() + 60 * MINUTE);
    const report = await schedules.catchUp();
    expect(report.triggers).toHaveLength(12);
    expect(report.triggers.every((trigger) => trigger.outcome === "STARTED")).toBe(true);
    expect(await runCount(schedule.id)).toBe(12);
    expect(report.triggers.map((trigger) => trigger.scheduledFor.toISOString())[0]).toBe(
      "2026-03-01T10:05:00.000Z",
    );
    expect(report.triggers.at(-1)?.scheduledFor.toISOString()).toBe("2026-03-01T11:00:00.000Z");
  });

  it("writes run_started, the run row and a workflow task for each started run", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition());
    now = new Date(START.getTime() + 5 * MINUTE);
    const report = await schedules.tick();
    const runId = report.triggers[0]?.runId ?? "";
    const events = await database.pool.query<{ event_type: string; payload: unknown }>(
      "select event_type, payload from run_events where run_id = $1",
      [runId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(["run_started"]);
    expect(events.rows[0]?.payload).toMatchObject({
      workflowType: "report",
      input: { kind: "nightly" },
    });
    const tasks = await database.pool.query<{
      task_type: string;
      queue_name: string;
      payload: unknown;
    }>("select task_type, queue_name, payload from tasks where run_id = $1", [runId]);
    expect(tasks.rows).toEqual([
      {
        task_type: "WORKFLOW_TASK",
        queue_name: QUEUE,
        payload: {
          reason: "schedule",
          scheduleId: schedule.id,
          scheduledFor: "2026-03-01T10:05:00.000Z",
        },
      },
    ]);
  });

  it("does not trigger before the first match", async () => {
    const schedules = manager();
    await schedules.create(definition());
    now = new Date(START.getTime() + 5 * MINUTE - 1);
    expect((await schedules.tick()).triggers).toEqual([]);
  });

  it("skip: a new run does not start before the previous one finishes", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "skip" }));
    now = new Date(START.getTime() + 15 * MINUTE);
    const first = await schedules.catchUp();
    expect(first.triggers.map((trigger) => trigger.outcome)).toEqual([
      "STARTED",
      "SKIPPED",
      "SKIPPED",
    ]);
    expect(await runCount(schedule.id)).toBe(1);

    await finishRuns(schedule.id);
    now = new Date(START.getTime() + 20 * MINUTE);
    const second = await schedules.catchUp();
    expect(second.triggers.map((trigger) => trigger.outcome)).toEqual(["STARTED"]);
    expect(await runCount(schedule.id)).toBe(2);
  });

  it("buffer_one: keeps only the latest overlapping trigger and starts it when the run ends", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "buffer_one" }));
    now = new Date(START.getTime() + 20 * MINUTE);
    const first = await schedules.catchUp();
    expect(first.triggers.map((trigger) => trigger.outcome)).toEqual([
      "STARTED",
      "BUFFERED",
      "BUFFERED",
      "BUFFERED",
    ]);
    expect(await runCount(schedule.id)).toBe(1);
    expect((await schedules.get(schedule.id)).bufferedFor?.toISOString()).toBe(
      "2026-03-01T10:20:00.000Z",
    );

    expect((await schedules.tick()).triggers).toEqual([]);

    await finishRuns(schedule.id);
    const drained = await schedules.tick();
    expect(drained.triggers).toHaveLength(1);
    expect(drained.triggers[0]).toMatchObject({ outcome: "STARTED" });
    expect(drained.triggers[0]?.scheduledFor.toISOString()).toBe("2026-03-01T10:20:00.000Z");
    expect(await runCount(schedule.id)).toBe(2);
    expect((await schedules.get(schedule.id)).bufferedFor).toBeNull();

    const outcomes = await database.pool.query<{ outcome: string; count: string }>(
      "select outcome, count(*) from schedule_triggers where schedule_id = $1 group by outcome order by outcome",
      [schedule.id],
    );
    expect(outcomes.rows).toEqual([
      { outcome: "SKIPPED", count: "2" },
      { outcome: "STARTED", count: "2" },
    ]);
  });

  it("allow_all: starts every trigger even while earlier runs are open", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "allow_all" }));
    now = new Date(START.getTime() + 15 * MINUTE);
    await schedules.catchUp();
    expect(await runCount(schedule.id)).toBe(3);
  });

  it("a paused schedule never triggers, however long the clock advances", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "allow_all" }));
    await schedules.pause(schedule.id);
    now = new Date(START.getTime() + 6 * 60 * MINUTE);
    expect((await schedules.catchUp()).triggers).toEqual([]);
    expect(await runCount(schedule.id)).toBe(0);
    expect(await schedules.nextDueAt()).toBeUndefined();
  });

  it("resume continues from the next match after now and does not make up the pause", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "allow_all" }));
    await schedules.pause(schedule.id);
    now = new Date(START.getTime() + 60 * MINUTE + 2 * MINUTE);
    const resumed = await schedules.resume(schedule.id);
    expect(resumed.state).toBe("ACTIVE");
    expect(resumed.nextFireAt?.toISOString()).toBe("2026-03-01T11:05:00.000Z");
    expect((await schedules.catchUp()).triggers).toEqual([]);
    now = new Date(START.getTime() + 60 * MINUTE + 10 * MINUTE);
    expect((await schedules.catchUp()).triggers).toHaveLength(2);
  });

  it("a new manager instance after downtime starts every missed trigger in order", async () => {
    const schedule = await manager().create(definition({ overlapPolicy: "allow_all" }));
    now = new Date(START.getTime() + 3 * 60 * MINUTE);
    const restarted = manager(7);
    const report = await restarted.catchUp();
    expect(report.triggers).toHaveLength(36);
    const times = report.triggers.map((trigger) => trigger.scheduledFor.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(await runCount(schedule.id)).toBe(36);
  });

  it("two managers ticking at once start each trigger exactly once", async () => {
    const schedule = await manager().create(definition({ overlapPolicy: "allow_all" }));
    now = new Date(START.getTime() + 60 * MINUTE);
    await Promise.all([manager().catchUp(), manager().catchUp(), manager().catchUp()]);
    expect(await runCount(schedule.id)).toBe(12);
    const triggers = await database.pool.query<{ count: string }>(
      "select count(distinct scheduled_for) from schedule_triggers where schedule_id = $1",
      [schedule.id],
    );
    expect(Number(triggers.rows[0]?.count)).toBe(12);
  });

  it("reads the cron fields in the schedule's time zone", async () => {
    const schedules = manager();
    const schedule = await schedules.create(
      definition({ cronExpression: "0 9 * * *", timeZone: "America/New_York" }),
    );
    expect(schedule.nextFireAt?.toISOString()).toBe("2026-03-01T14:00:00.000Z");
    now = new Date("2026-03-01T14:00:00.000Z");
    const report = await schedules.tick();
    expect(report.triggers).toHaveLength(1);
    expect((await schedules.get(schedule.id)).nextFireAt?.toISOString()).toBe(
      "2026-03-02T14:00:00.000Z",
    );
  });

  it("a start in the past makes the first tick start every trigger since then", async () => {
    const schedules = manager();
    const schedule = await schedules.create(
      definition({ overlapPolicy: "allow_all", startAt: new Date(START.getTime() - 30 * MINUTE) }),
    );
    const report = await schedules.catchUp();
    expect(report.triggers).toHaveLength(6);
    expect(report.triggers[0]?.scheduledFor.toISOString()).toBe("2026-03-01T09:35:00.000Z");
    expect(await runCount(schedule.id)).toBe(6);
  });

  it("backfill starts the triggers inside the range once, even when repeated", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "allow_all" }));
    const from = new Date("2026-02-28T00:00:00.000Z");
    const to = new Date("2026-02-28T01:00:00.000Z");
    const first = await schedules.backfill(schedule.id, from, to);
    expect(first.triggers).toHaveLength(12);
    expect(first.triggers[0]?.scheduledFor.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    const again = await schedules.backfill(schedule.id, from, to);
    expect(again.triggers).toEqual([]);
    expect(await runCount(schedule.id)).toBe(12);
    expect((await schedules.get(schedule.id)).nextFireAt?.toISOString()).toBe(
      "2026-03-01T10:05:00.000Z",
    );
  });

  it("backfill obeys the overlap policy", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "skip" }));
    const report = await schedules.backfill(
      schedule.id,
      new Date("2026-02-28T00:00:00.000Z"),
      new Date("2026-02-28T00:20:00.000Z"),
    );
    expect(report.triggers.map((trigger) => trigger.outcome)).toEqual([
      "STARTED",
      "SKIPPED",
      "SKIPPED",
      "SKIPPED",
    ]);
  });

  it("rejects an invalid expression, a duplicate name and an unknown id", async () => {
    const schedules = manager();
    await expect(schedules.create(definition({ cronExpression: "nope" }))).rejects.toThrow(
      InvalidScheduleError,
    );
    await schedules.create(definition());
    await expect(schedules.create(definition())).rejects.toThrow(ScheduleAlreadyExistsError);
    await expect(schedules.get("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      ScheduleNotFoundError,
    );
  });

  it("never starts a trigger early when the wall clock steps backwards", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition({ overlapPolicy: "allow_all" }));
    now = new Date(START.getTime() + 10 * MINUTE);
    await schedules.tick();
    now = new Date(START.getTime() + MINUTE);
    expect((await schedules.tick()).triggers).toEqual([]);
    expect(await runCount(schedule.id)).toBe(2);
  });
});
