import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore } from "../event-store/event-store.ts";
import {
  ScheduleNotFoundError,
  createScheduleManager,
  type CreateScheduleInput,
  type OverlapPolicy,
} from "./schedule-manager.ts";

const QUEUE = "default/workflows";
const START = new Date("2026-03-01T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("schedule overlap policies and backfill", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let now = START;
  const clock = { now: () => now };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    now = START;
  });

  function manager() {
    return createScheduleManager(database.pool, { queueName: QUEUE, clock });
  }

  function hourly(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
    return {
      namespaceId,
      name: "hourly",
      cronExpression: "0 * * * *",
      workflowType: "report",
      catchUpPolicy: "all",
      ...overrides,
    };
  }

  function advance(ms: number): void {
    now = new Date(now.getTime() + ms);
  }

  async function runs(scheduleId: string): Promise<{ id: string; status: string }[]> {
    const result = await database.pool.query<{ id: string; status: string }>(
      "select id, status from workflow_runs where schedule_id = $1 order by started_at, id",
      [scheduleId],
    );
    return result.rows;
  }

  async function closeRun(runId: string, status = "COMPLETED"): Promise<void> {
    await database.pool.query(
      "update workflow_runs set status = $2, closed_at = now() where id = $1",
      [runId, status],
    );
  }

  async function openRunCount(scheduleId: string): Promise<number> {
    return (await runs(scheduleId)).filter((run) => run.status === "RUNNING").length;
  }

  async function overlapTimeline(policy: OverlapPolicy): Promise<string[]> {
    const schedules = manager();
    const schedule = await schedules.create(hourly({ overlapPolicy: policy }));
    const outcomes: string[] = [];
    for (let hour = 1; hour <= 3; hour += 1) {
      advance(HOUR);
      const report = await schedules.tick();
      outcomes.push(...report.triggers.map((trigger) => trigger.outcome));
    }
    outcomes.push(`open:${String(await openRunCount(schedule.id))}`);
    return outcomes;
  }

  it("skip: on a fake clock, three overlapping hours start one run and skip two", async () => {
    expect(await overlapTimeline("skip")).toEqual(["STARTED", "SKIPPED", "SKIPPED", "open:1"]);
  });

  it("buffer_one: on a fake clock, the last buffered hour starts the moment the open run closes", async () => {
    const outcomes = await overlapTimeline("buffer_one");
    expect(outcomes).toEqual(["STARTED", "BUFFERED", "BUFFERED", "open:1"]);
    const schedules = manager();
    const [schedule] = await schedules.list(namespaceId);
    const [first] = await runs(schedule?.id ?? "");
    await closeRun(first?.id ?? "");
    const drained = await schedules.tick();
    expect(drained.triggers.map((trigger) => trigger.scheduledFor.toISOString())).toEqual([
      "2026-03-01T13:00:00.000Z",
    ]);
    expect(await openRunCount(schedule?.id ?? "")).toBe(1);
  });

  it("allow_all: on a fake clock, every overlapping hour starts its own run", async () => {
    expect(await overlapTimeline("allow_all")).toEqual(["STARTED", "STARTED", "STARTED", "open:3"]);
  });

  it("cancel_other: on a fake clock, a trigger cancels the open run and starts once it closed", async () => {
    const schedules = manager();
    const schedule = await schedules.create(hourly({ overlapPolicy: "cancel_other" }));
    advance(HOUR);
    const first = await schedules.tick();
    const firstRunId = first.triggers[0]?.runId ?? "";
    expect(first.triggers).toMatchObject([{ outcome: "STARTED" }]);

    advance(HOUR);
    const second = await schedules.tick();
    expect(second.triggers).toMatchObject([{ outcome: "BUFFERED", cancelledRunIds: [firstRunId] }]);
    const history = await createPostgresEventStore(database.pool).read(firstRunId);
    expect(history.map((stored) => stored.event.type)).toEqual(["run_started", "cancel_requested"]);
    const cancelTask = await database.pool.query<{ payload: { reason: string } }>(
      "select payload from tasks where run_id = $1 and payload->>'reason' <> 'schedule'",
      [firstRunId],
    );
    expect(cancelTask.rows).toHaveLength(1);
    expect(await openRunCount(schedule.id)).toBe(1);
    expect((await schedules.tick()).triggers).toEqual([]);

    await closeRun(firstRunId, "CANCELLED");
    const drained = await schedules.tick();
    expect(drained.triggers).toMatchObject([{ outcome: "STARTED" }]);
    expect(drained.triggers[0]?.scheduledFor.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect((await runs(schedule.id)).map((run) => run.status)).toEqual(["CANCELLED", "RUNNING"]);
  });

  it("cancel_other: a second overlapping trigger replaces the buffered one and cancels nothing twice", async () => {
    const schedules = manager();
    const schedule = await schedules.create(hourly({ overlapPolicy: "cancel_other" }));
    advance(HOUR);
    const [started] = (await schedules.tick()).triggers;
    advance(HOUR);
    await schedules.tick();
    advance(HOUR);
    const third = await schedules.tick();
    expect(third.triggers).toMatchObject([{ outcome: "BUFFERED" }]);
    const history = await createPostgresEventStore(database.pool).read(started?.runId ?? "");
    expect(history.filter((stored) => stored.event.type === "cancel_requested")).toHaveLength(1);
    const triggers = await schedules.listTriggers(schedule.id);
    expect(triggers.map((trigger) => trigger.outcome)).toEqual(["BUFFERED", "SKIPPED", "STARTED"]);
  });

  it("a backfill of 24 hours of an hourly schedule starts 24 runs exactly once when run twice", async () => {
    const schedules = manager();
    const schedule = await schedules.create(hourly({ overlapPolicy: "allow_all" }));
    const from = new Date("2026-02-27T00:00:00.000Z");
    const to = new Date("2026-02-28T00:00:00.000Z");
    const first = await schedules.backfill(schedule.id, from, to);
    const second = await schedules.backfill(schedule.id, from, to);
    expect(first.triggers).toHaveLength(24);
    expect(first.triggers.every((trigger) => trigger.outcome === "STARTED")).toBe(true);
    expect(second.triggers).toEqual([]);
    expect(await runs(schedule.id)).toHaveLength(24);
    const instants = await database.pool.query<{ count: string }>(
      "select count(distinct scheduled_for) from schedule_triggers where schedule_id = $1",
      [schedule.id],
    );
    expect(Number(instants.rows[0]?.count)).toBe(24);
  });

  it("two backfills of the same 24 hours at once start 24 runs between them", async () => {
    const schedule = await manager().create(hourly({ overlapPolicy: "allow_all" }));
    const from = new Date("2026-02-27T00:00:00.000Z");
    const to = new Date("2026-02-28T00:00:00.000Z");
    const reports = await Promise.all([
      manager().backfill(schedule.id, from, to),
      manager().backfill(schedule.id, from, to),
      manager().backfill(schedule.id, from, to),
    ]);
    expect(reports.reduce((sum, report) => sum + report.triggers.length, 0)).toBe(24);
    expect(await runs(schedule.id)).toHaveLength(24);
  });

  it("a backfill overlap override starts every hour of a skipping, paused schedule", async () => {
    const schedules = manager();
    const schedule = await schedules.create(hourly({ overlapPolicy: "skip" }));
    await schedules.pause(schedule.id);
    const report = await schedules.backfill(
      schedule.id,
      new Date("2026-02-27T00:00:00.000Z"),
      new Date("2026-02-28T00:00:00.000Z"),
      { overlapPolicy: "allow_all" },
    );
    expect(report.triggers).toHaveLength(24);
    expect(await openRunCount(schedule.id)).toBe(24);
    expect((await schedules.get(schedule.id)).state).toBe("PAUSED");
    advance(5 * HOUR);
    expect((await schedules.catchUp()).triggers).toEqual([]);
  });

  it("lists a namespace's schedules by name and a schedule's triggers newest first", async () => {
    const schedules = manager();
    const second = await schedules.create(hourly({ name: "b-hourly" }));
    const first = await schedules.create(hourly({ name: "a-hourly" }));
    expect((await schedules.list(namespaceId)).map((schedule) => schedule.id)).toEqual([
      first.id,
      second.id,
    ]);
    await schedules.backfill(
      first.id,
      new Date("2026-02-27T00:00:00.000Z"),
      new Date("2026-02-27T03:00:00.000Z"),
      { overlapPolicy: "allow_all" },
    );
    const triggers = await schedules.listTriggers(first.id, 2);
    expect(triggers.map((trigger) => trigger.scheduledFor.toISOString())).toEqual([
      "2026-02-27T02:00:00.000Z",
      "2026-02-27T01:00:00.000Z",
    ]);
    expect(triggers.every((trigger) => trigger.runId !== null)).toBe(true);
    await expect(schedules.listTriggers("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      ScheduleNotFoundError,
    );
    await expect(schedules.listTriggers(first.id, 0)).rejects.toThrow(RangeError);
  });
});
