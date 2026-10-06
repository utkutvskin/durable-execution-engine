import { describe, expect, it } from "vitest";
import { InvalidScheduleError, cronTimesBetween, nextCronTime, parseCron } from "./cron.js";

function iso(date: Date): string {
  return date.toISOString();
}

describe("cron parsing", () => {
  it("expands lists, ranges and steps", () => {
    const schedule = parseCron("0,30 9-11/2 * * *");
    expect([...schedule.minutes]).toEqual([0, 30]);
    expect([...schedule.hours]).toEqual([9, 11]);
  });

  it("reads month and day names and treats 7 as sunday", () => {
    const schedule = parseCron("0 0 * jan-mar mon,7");
    expect([...schedule.months]).toEqual([1, 2, 3]);
    expect([...schedule.daysOfWeek].sort()).toEqual([0, 1]);
  });

  it("expands macros", () => {
    expect(parseCron("@hourly").expression).toBe("0 * * * *");
    expect(parseCron("@daily").expression).toBe("0 0 * * *");
  });

  it.each([
    "* * * *",
    "60 * * * *",
    "* 24 * * *",
    "*/0 * * * *",
    "5-1 * * * *",
    "a * * * *",
    "* * 0 * *",
    "1//2 * * * *",
  ])("rejects %s", (expression) => {
    expect(() => parseCron(expression)).toThrow(InvalidScheduleError);
  });

  it("rejects an unknown time zone", () => {
    expect(() => parseCron("* * * * *", "Mars/Olympus")).toThrow(InvalidScheduleError);
  });
});

describe("next cron time", () => {
  it("finds the next five minute boundary strictly after the given instant", () => {
    const schedule = parseCron("*/5 * * * *");
    expect(iso(nextCronTime(schedule, new Date("2026-03-01T10:00:00.000Z")))).toBe(
      "2026-03-01T10:05:00.000Z",
    );
    expect(iso(nextCronTime(schedule, new Date("2026-03-01T10:03:21.000Z")))).toBe(
      "2026-03-01T10:05:00.000Z",
    );
  });

  it("rolls over midnight, month and year", () => {
    const schedule = parseCron("30 23 31 12 *");
    expect(iso(nextCronTime(schedule, new Date("2026-12-31T23:30:00.000Z")))).toBe(
      "2027-12-31T23:30:00.000Z",
    );
  });

  it("matches either day field when both are restricted", () => {
    const schedule = parseCron("0 12 15 * fri");
    const times = cronTimesBetween(
      schedule,
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-04-01T00:00:00.000Z"),
    ).map(iso);
    expect(times).toEqual([
      "2026-03-06T12:00:00.000Z",
      "2026-03-13T12:00:00.000Z",
      "2026-03-15T12:00:00.000Z",
      "2026-03-20T12:00:00.000Z",
      "2026-03-27T12:00:00.000Z",
    ]);
  });

  it("reads the fields in the given time zone", () => {
    const schedule = parseCron("0 9 * * *", "America/New_York");
    expect(iso(nextCronTime(schedule, new Date("2026-01-15T00:00:00.000Z")))).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    expect(iso(nextCronTime(schedule, new Date("2026-07-15T00:00:00.000Z")))).toBe(
      "2026-07-15T13:00:00.000Z",
    );
  });

  it("keeps the local hour across the spring forward change", () => {
    const schedule = parseCron("30 9 * * *", "Europe/Berlin");
    const times = cronTimesBetween(
      schedule,
      new Date("2026-03-27T00:00:00.000Z"),
      new Date("2026-03-30T00:00:00.000Z"),
    ).map(iso);
    expect(times).toEqual([
      "2026-03-27T08:30:00.000Z",
      "2026-03-28T08:30:00.000Z",
      "2026-03-29T07:30:00.000Z",
    ]);
  });

  it("skips a local time that does not exist on the spring forward day", () => {
    const schedule = parseCron("30 2 * * *", "Europe/Berlin");
    const times = cronTimesBetween(
      schedule,
      new Date("2026-03-28T00:00:00.000Z"),
      new Date("2026-03-31T00:00:00.000Z"),
    ).map(iso);
    expect(times).toEqual(["2026-03-28T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]);
  });

  it("supports half hour offsets", () => {
    const schedule = parseCron("0 0 * * *", "Asia/Kolkata");
    expect(iso(nextCronTime(schedule, new Date("2026-03-01T00:00:00.000Z")))).toBe(
      "2026-03-01T18:30:00.000Z",
    );
  });

  it("throws for an expression that never matches", () => {
    expect(() =>
      nextCronTime(parseCron("0 0 31 2 *"), new Date("2026-01-01T00:00:00.000Z")),
    ).toThrow(InvalidScheduleError);
  });

  it("counts exactly 12 five minute triggers in an hour", () => {
    const times = cronTimesBetween(
      parseCron("*/5 * * * *"),
      new Date("2026-03-01T10:00:01.000Z"),
      new Date("2026-03-01T11:00:01.000Z"),
    );
    expect(times).toHaveLength(12);
  });
});
