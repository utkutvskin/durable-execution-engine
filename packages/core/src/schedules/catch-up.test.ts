import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { createScheduleManager, type CreateScheduleInput } from "./schedule-manager.js";

const START = new Date("2026-06-01T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("schedule catch-up policy and error state", () => {
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
    return createScheduleManager(database.pool, { queueName: "default", clock });
  }

  function definition(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
    return {
      namespaceId,
      name: "every-minute",
      cronExpression: "* * * * *",
      workflowType: "report",
      ...overrides,
    };
  }

  it("starts one run for a per-minute schedule that was offline for a simulated day", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition());
    now = new Date(START.getTime() + DAY);

    const report = await schedules.catchUp();

    expect(schedule.catchUpPolicy).toBe("latest_only");
    expect(report.triggers).toHaveLength(1);
    expect(report.triggers[0]?.outcome).toBe("STARTED");
  });

  it("starts the latest missed instant and schedules the next one after now", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition());
    now = new Date(START.getTime() + DAY + 30_000);

    const report = await schedules.catchUp();

    expect(report.triggers[0]?.scheduledFor).toEqual(new Date(START.getTime() + DAY));
    const stored = await schedules.get(schedule.id);
    expect(stored.nextFireAt).toEqual(new Date(START.getTime() + DAY + MINUTE));
    expect(stored.lastFiredAt).toEqual(new Date(START.getTime() + DAY));
  });

  it("starts nothing more on the next tick after a latest_only catch-up", async () => {
    const schedules = manager();
    await schedules.create(definition());
    now = new Date(START.getTime() + DAY);
    await schedules.catchUp();

    expect((await schedules.catchUp()).triggers).toEqual([]);
  });

  it("starts every missed instant inside the window under the all policy", async () => {
    const schedules = manager();
    await schedules.create(definition({ catchUpPolicy: "all", catchUpWindowMs: 10 * MINUTE }));
    now = new Date(START.getTime() + DAY);

    const report = await schedules.catchUp();

    const instants = report.triggers.map((trigger) => trigger.scheduledFor.getTime());
    expect(instants).toHaveLength(11);
    expect(instants[0]).toBe(START.getTime() + DAY - 10 * MINUTE);
    expect(instants.at(-1)).toBe(START.getTime() + DAY);
  });

  it("starts every missed instant under the all policy without a window", async () => {
    const schedules = manager();
    await schedules.create(definition({ catchUpPolicy: "all" }));
    now = new Date(START.getTime() + 30 * MINUTE);

    expect((await schedules.catchUp()).triggers).toHaveLength(30);
  });

  it("rejects a catch-up window that is not a positive integer", async () => {
    await expect(manager().create(definition({ catchUpWindowMs: 0 }))).rejects.toThrow(RangeError);
  });

  it("reports an invalid time zone as an error state instead of silently disabling the schedule", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition());
    await database.pool.query("update schedules set time_zone = 'Mars/Olympus' where id = $1", [
      schedule.id,
    ]);
    now = new Date(START.getTime() + 5 * MINUTE);

    const report = await schedules.tick();

    expect(report.triggers).toEqual([]);
    const stored = await schedules.get(schedule.id);
    expect(stored.state).toBe("ERRORED");
    expect(stored.error).toContain("Mars/Olympus");
    expect(stored.nextFireAt).toBeNull();
  });

  it("reports an invalid cron expression as an error state and keeps it until fixed", async () => {
    const schedules = manager();
    const schedule = await schedules.create(definition());
    await database.pool.query("update schedules set cron_expression = 'not a cron' where id = $1", [
      schedule.id,
    ]);
    now = new Date(START.getTime() + 2 * MINUTE);
    await schedules.tick();

    const resumedBroken = await schedules.resume(schedule.id);
    expect(resumedBroken.state).toBe("ERRORED");

    await database.pool.query("update schedules set cron_expression = '* * * * *' where id = $1", [
      schedule.id,
    ]);
    const resumedFixed = await schedules.resume(schedule.id);
    expect(resumedFixed.state).toBe("ACTIVE");
    expect(resumedFixed.error).toBeNull();
    expect(resumedFixed.nextFireAt).toEqual(new Date(now.getTime() + MINUTE));
  });
});
