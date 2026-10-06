/**
 * Raised when a cron expression or a time zone cannot be understood.
 */
export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

/**
 * A parsed five field cron expression (minute, hour, day of month, month,
 * day of week) together with the time zone its fields are read in.
 */
export interface CronSchedule {
  readonly expression: string;
  readonly timeZone: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly restrictsDayOfMonth: boolean;
  readonly restrictsDayOfWeek: boolean;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  readonly nameOffset?: number;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { name: "day of week", min: 0, max: 7, names: WEEKDAY_NAMES, nameOffset: 0 },
];

const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MAX_SEARCH_STEPS = 200_000;
const MINUTE_MS = 60_000;

function parseValue(text: string, spec: FieldSpec): number {
  const lowered = text.toLowerCase();
  const namedIndex = spec.names?.indexOf(lowered) ?? -1;
  if (namedIndex >= 0) {
    return namedIndex + (spec.nameOffset ?? 0);
  }
  if (!/^\d+$/.test(text)) {
    throw new InvalidScheduleError(`invalid ${spec.name} value "${text}"`);
  }
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    throw new InvalidScheduleError(
      `${spec.name} value ${String(value)} is outside ${String(spec.min)}-${String(spec.max)}`,
    );
  }
  return value;
}

function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangeText = "", stepText, ...rest] = part.split("/");
    if (rest.length > 0 || rangeText === "") {
      throw new InvalidScheduleError(`invalid ${spec.name} field "${field}"`);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) <= 0) {
        throw new InvalidScheduleError(`invalid ${spec.name} step "${stepText}"`);
      }
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = spec.min;
      to = spec.max;
    } else if (rangeText.includes("-")) {
      const [startText = "", endText = "", ...extra] = rangeText.split("-");
      if (extra.length > 0) {
        throw new InvalidScheduleError(`invalid ${spec.name} range "${rangeText}"`);
      }
      from = parseValue(startText, spec);
      to = parseValue(endText, spec);
      if (from > to) {
        throw new InvalidScheduleError(`${spec.name} range "${rangeText}" runs backwards`);
      }
    } else {
      from = parseValue(rangeText, spec);
      to = stepText === undefined ? from : spec.max;
    }
    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }
  return values;
}

function createFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    throw new InvalidScheduleError(`unknown time zone "${timeZone}"`);
  }
}

/**
 * Parses a five field cron expression (or one of `@yearly`, `@monthly`,
 * `@weekly`, `@daily`, `@hourly`) read in `timeZone` (an IANA name, UTC by
 * default). Fields accept `*`, lists, ranges, steps, month names and day
 * names; day of week 7 means Sunday. Throws `InvalidScheduleError` for
 * anything else.
 */
export function parseCron(expression: string, timeZone = "UTC"): CronSchedule {
  createFormatter(timeZone);
  const trimmed = expression.trim();
  const resolved = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = resolved.split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidScheduleError(
      `a cron expression needs 5 fields, got ${String(fields.length)} in "${expression}"`,
    );
  }
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const [minuteSpec, hourSpec, dayOfMonthSpec, monthSpec, dayOfWeekSpec] = FIELD_SPECS;
  if (
    minuteSpec === undefined ||
    hourSpec === undefined ||
    dayOfMonthSpec === undefined ||
    monthSpec === undefined ||
    dayOfWeekSpec === undefined
  ) {
    throw new InvalidScheduleError("field specifications are missing");
  }
  const daysOfWeek = new Set(
    [...parseField(dayOfWeek, dayOfWeekSpec)].map((day) => (day === 7 ? 0 : day)),
  );
  return {
    expression: resolved,
    timeZone,
    minutes: parseField(minute, minuteSpec),
    hours: parseField(hour, hourSpec),
    daysOfMonth: parseField(dayOfMonth, dayOfMonthSpec),
    months: parseField(month, monthSpec),
    daysOfWeek,
    restrictsDayOfMonth: !dayOfMonth.startsWith("*"),
    restrictsDayOfWeek: !dayOfWeek.startsWith("*"),
  };
}

interface LocalParts {
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

function readLocalParts(formatter: Intl.DateTimeFormat, instant: Date): LocalParts {
  const parts = new Map<string, number>();
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") {
      parts.set(part.type, Number(part.value));
    }
  }
  const year = parts.get("year") ?? 0;
  const month = parts.get("month") ?? 0;
  const day = parts.get("day") ?? 0;
  return {
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    hour: parts.get("hour") ?? 0,
    minute: parts.get("minute") ?? 0,
  };
}

function dayMatches(schedule: CronSchedule, parts: LocalParts): boolean {
  const dayOfMonthMatches = schedule.daysOfMonth.has(parts.day);
  const dayOfWeekMatches = schedule.daysOfWeek.has(parts.weekday);
  if (schedule.restrictsDayOfMonth && schedule.restrictsDayOfWeek) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

/**
 * The first instant strictly after `after` that matches `schedule`, at
 * whole-minute resolution. A local time that does not exist (the hour
 * skipped when clocks go forward) never matches, so that day has no run at
 * that time. Throws `InvalidScheduleError` when no match exists within
 * several years, such as `0 0 31 2 *`.
 */
export function nextCronTime(schedule: CronSchedule, after: Date): Date {
  const formatter = createFormatter(schedule.timeZone);
  let candidate = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < MAX_SEARCH_STEPS; step += 1) {
    const parts = readLocalParts(formatter, new Date(candidate));
    const minutesIntoDay = parts.hour * 60 + parts.minute;
    if (!schedule.months.has(parts.month) || !dayMatches(schedule, parts)) {
      candidate += (24 * 60 - minutesIntoDay) * MINUTE_MS;
    } else if (!schedule.hours.has(parts.hour)) {
      candidate += (60 - parts.minute) * MINUTE_MS;
    } else if (!schedule.minutes.has(parts.minute)) {
      candidate += MINUTE_MS;
    } else {
      return new Date(candidate);
    }
  }
  throw new InvalidScheduleError(`"${schedule.expression}" never matches`);
}

/**
 * Every matching instant in `[from, to)`, in order. At most `limit` are
 * returned (default 10000) so a careless range cannot exhaust memory.
 */
export function cronTimesBetween(
  schedule: CronSchedule,
  from: Date,
  to: Date,
  limit = 10_000,
): Date[] {
  const times: Date[] = [];
  let cursor = new Date(from.getTime() - 1);
  while (times.length < limit) {
    const next = nextCronTime(schedule, cursor);
    if (next.getTime() >= to.getTime()) {
      break;
    }
    times.push(next);
    cursor = next;
  }
  return times;
}
