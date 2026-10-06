import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.js";
import { appendEventsOnClient } from "../event-store/event-store.js";
import { systemClock, type ClockSource } from "../workflow/sources.js";
import { createMonotonicClock } from "../timers/monotonic-clock.js";
import { cronTimesBetween, nextCronTime, parseCron, InvalidScheduleError } from "./cron.js";

/**
 * What to do when a schedule fires while a run it started earlier is still
 * open: `skip` drops the new trigger, `buffer_one` keeps the latest one and
 * starts it when the open run ends, `allow_all` starts it anyway.
 */
export type OverlapPolicy = "skip" | "buffer_one" | "allow_all";

/**
 * How a trigger was handled.
 */
export type TriggerOutcome = "STARTED" | "SKIPPED" | "BUFFERED";

/**
 * A schedule as stored. `nextFireAt` is `null` for a paused schedule that
 * never resumed and for an expression with no further match.
 */
export interface ScheduleRecord {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly workflowType: string;
  readonly input: unknown;
  readonly overlapPolicy: OverlapPolicy;
  readonly state: "ACTIVE" | "PAUSED";
  readonly nextFireAt: Date | null;
  readonly lastFiredAt: Date | null;
  readonly bufferedFor: Date | null;
}

/**
 * What `ScheduleManager.create` needs. `startAt` is the instant after which
 * the first trigger is looked for (default: now); a `startAt` in the past
 * makes the next tick start every trigger since then.
 */
export interface CreateScheduleInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly cronExpression: string;
  readonly workflowType: string;
  readonly input?: unknown;
  readonly timeZone?: string;
  readonly overlapPolicy?: OverlapPolicy;
  readonly startAt?: Date;
}

/**
 * One trigger of a schedule and what became of it. `runId` is set when a
 * run was started.
 */
export interface ScheduleTrigger {
  readonly scheduleId: string;
  readonly scheduledFor: Date;
  readonly outcome: TriggerOutcome;
  readonly runId?: string;
}

/**
 * What one tick did, in the order the triggers were handled.
 */
export interface ScheduleTickReport {
  readonly triggers: readonly ScheduleTrigger[];
}

/**
 * Options for `createScheduleManager`. `queueName` is the queue the
 * `WORKFLOW_TASK` of a started run goes to. `batchSize` bounds how many
 * triggers one tick handles (default 100).
 */
export interface ScheduleManagerOptions {
  readonly queueName: string;
  readonly clock?: ClockSource;
  readonly codec?: Codec;
  readonly batchSize?: number;
}

/**
 * Raised when a schedule with the same name already exists in a namespace.
 */
export class ScheduleAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`schedule "${name}" already exists`);
    this.name = "ScheduleAlreadyExistsError";
  }
}

/**
 * Raised when a schedule id is unknown.
 */
export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`schedule "${id}" does not exist`);
    this.name = "ScheduleNotFoundError";
  }
}

/**
 * Keeps cron schedules in postgres and starts a run for each trigger that
 * comes due. All state is in the database, so a restarted engine continues
 * from the stored `nextFireAt` and starts every trigger it missed.
 */
export interface ScheduleManager {
  /** Stores a schedule. Throws `InvalidScheduleError` or `ScheduleAlreadyExistsError`. */
  create(input: CreateScheduleInput): Promise<ScheduleRecord>;

  /** Reads a schedule. Throws `ScheduleNotFoundError`. */
  get(id: string): Promise<ScheduleRecord>;

  /** Stops triggering. A paused schedule starts nothing, not even a buffered trigger. */
  pause(id: string): Promise<ScheduleRecord>;

  /**
   * Starts triggering again from the next match after now. Triggers that
   * fell inside the pause are not made up; use `backfill` for that.
   */
  resume(id: string): Promise<ScheduleRecord>;

  /**
   * Starts the buffered trigger of every schedule whose previous run ended,
   * then handles due triggers, earliest first, one transaction each.
   * Concurrent ticks never handle a trigger twice.
   */
  tick(): Promise<ScheduleTickReport>;

  /** Ticks until nothing is due, which is what a starting engine runs. */
  catchUp(): Promise<ScheduleTickReport>;

  /**
   * Handles every trigger in `[from, to)` under the schedule's overlap
   * policy, paused or not. A trigger that was already handled is not
   * handled again, so a backfill can be repeated safely.
   */
  backfill(id: string, from: Date, to: Date): Promise<ScheduleTickReport>;

  /** The earliest `nextFireAt` among active schedules, if any. */
  nextDueAt(): Promise<Date | undefined>;
}

interface ScheduleRow {
  id: string;
  namespace_id: string;
  name: string;
  cron_expression: string;
  time_zone: string;
  workflow_type: string;
  input: unknown;
  overlap_policy: OverlapPolicy;
  state: "ACTIVE" | "PAUSED";
  next_fire_at: Date | null;
  last_fired_at: Date | null;
  buffered_for: Date | null;
}

const DEFAULT_BATCH_SIZE = 100;
const UNIQUE_VIOLATION = "23505";

function toRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    name: row.name,
    cronExpression: row.cron_expression,
    timeZone: row.time_zone,
    workflowType: row.workflow_type,
    input: row.input,
    overlapPolicy: row.overlap_policy,
    state: row.state,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    bufferedFor: row.buffered_for,
  };
}

function requireRow(row: ScheduleRow | undefined, id: string): ScheduleRow {
  if (row === undefined) {
    throw new ScheduleNotFoundError(id);
  }
  return row;
}

function nextAfter(row: ScheduleRow, after: Date): Date | null {
  try {
    return nextCronTime(parseCron(row.cron_expression, row.time_zone), after);
  } catch (error) {
    if (error instanceof InvalidScheduleError) {
      return null;
    }
    throw error;
  }
}

/**
 * Creates a `ScheduleManager` over `pool`. The clock is wrapped in a
 * monotonic clock, so a wall clock stepped backwards delays a trigger but
 * never starts one early or twice.
 */
export function createScheduleManager(
  pool: Pool,
  options: ScheduleManagerOptions,
): ScheduleManager {
  const clock = createMonotonicClock(options.clock ?? systemClock);
  const codec = options.codec ?? jsonCodec;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`batchSize must be a positive integer, got ${String(batchSize)}`);
  }

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function startRun(
    client: PoolClient,
    schedule: ScheduleRow,
    scheduledFor: Date,
  ): Promise<string> {
    const run = await client.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, input, schedule_id)
       values ($1, $2, $3::jsonb, $4)
       returning id`,
      [schedule.namespace_id, schedule.workflow_type, JSON.stringify(schedule.input), schedule.id],
    );
    const runId = run.rows[0]?.id ?? "";
    await appendEventsOnClient(client, codec, runId, 0, [
      { type: "run_started", workflowType: schedule.workflow_type, input: schedule.input },
    ]);
    await client.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
       values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
      [
        schedule.namespace_id,
        runId,
        options.queueName,
        JSON.stringify({
          reason: "schedule",
          scheduleId: schedule.id,
          scheduledFor: scheduledFor.toISOString(),
        }),
      ],
    );
    return runId;
  }

  async function hasOpenRun(client: PoolClient, scheduleId: string): Promise<boolean> {
    const open = await client.query(
      "select 1 from workflow_runs where schedule_id = $1 and status = 'RUNNING' limit 1",
      [scheduleId],
    );
    return open.rowCount === 1;
  }

  async function recordTrigger(
    client: PoolClient,
    scheduleId: string,
    scheduledFor: Date,
    outcome: TriggerOutcome,
    runId: string | undefined,
  ): Promise<boolean> {
    const inserted = await client.query(
      `insert into schedule_triggers (schedule_id, scheduled_for, outcome, run_id)
       values ($1, $2, $3, $4)
       on conflict (schedule_id, scheduled_for) do nothing`,
      [scheduleId, scheduledFor, outcome, runId ?? null],
    );
    return inserted.rowCount === 1;
  }

  async function handleTrigger(
    client: PoolClient,
    schedule: ScheduleRow,
    scheduledFor: Date,
  ): Promise<ScheduleTrigger | undefined> {
    const known = await client.query(
      "select 1 from schedule_triggers where schedule_id = $1 and scheduled_for = $2",
      [schedule.id, scheduledFor],
    );
    if (known.rowCount === 1) {
      return undefined;
    }
    const overlapping =
      schedule.overlap_policy !== "allow_all" && (await hasOpenRun(client, schedule.id));
    if (!overlapping) {
      const runId = await startRun(client, schedule, scheduledFor);
      await recordTrigger(client, schedule.id, scheduledFor, "STARTED", runId);
      return { scheduleId: schedule.id, scheduledFor, outcome: "STARTED", runId };
    }
    if (schedule.overlap_policy === "buffer_one") {
      const replaced = schedule.buffered_for;
      await client.query(
        "update schedules set buffered_for = $2, updated_at = now() where id = $1",
        [schedule.id, scheduledFor],
      );
      schedule.buffered_for = scheduledFor;
      if (replaced !== null) {
        await client.query(
          "update schedule_triggers set outcome = 'SKIPPED' where schedule_id = $1 and scheduled_for = $2",
          [schedule.id, replaced],
        );
      }
      await recordTrigger(client, schedule.id, scheduledFor, "BUFFERED", undefined);
      return { scheduleId: schedule.id, scheduledFor, outcome: "BUFFERED" };
    }
    await recordTrigger(client, schedule.id, scheduledFor, "SKIPPED", undefined);
    return { scheduleId: schedule.id, scheduledFor, outcome: "SKIPPED" };
  }

  async function drainNextBuffer(): Promise<ScheduleTrigger | undefined> {
    return inTransaction(async (client) => {
      const found = await client.query<ScheduleRow>(
        `select * from schedules s
         where s.state = 'ACTIVE' and s.buffered_for is not null
           and not exists (
             select 1 from workflow_runs r where r.schedule_id = s.id and r.status = 'RUNNING'
           )
         order by s.buffered_for, s.id
         limit 1
         for update skip locked`,
      );
      const schedule = found.rows[0];
      const scheduledFor = schedule?.buffered_for;
      if (schedule === undefined || scheduledFor === null || scheduledFor === undefined) {
        return undefined;
      }
      const runId = await startRun(client, schedule, scheduledFor);
      await client.query(
        `update schedule_triggers set outcome = 'STARTED', run_id = $3
         where schedule_id = $1 and scheduled_for = $2`,
        [schedule.id, scheduledFor, runId],
      );
      await client.query(
        "update schedules set buffered_for = null, updated_at = now() where id = $1",
        [schedule.id],
      );
      return { scheduleId: schedule.id, scheduledFor, outcome: "STARTED", runId };
    });
  }

  async function fireNextDue(now: Date): Promise<ScheduleTrigger | "none"> {
    return inTransaction(async (client) => {
      const found = await client.query<ScheduleRow>(
        `select * from schedules
         where state = 'ACTIVE' and next_fire_at <= $1
         order by next_fire_at, id
         limit 1
         for update skip locked`,
        [now],
      );
      const schedule = found.rows[0];
      const scheduledFor = schedule?.next_fire_at;
      if (schedule === undefined || scheduledFor === null || scheduledFor === undefined) {
        return "none";
      }
      const trigger = await handleTrigger(client, schedule, scheduledFor);
      await client.query(
        `update schedules set next_fire_at = $2, last_fired_at = $3, updated_at = now()
         where id = $1`,
        [schedule.id, nextAfter(schedule, scheduledFor), scheduledFor],
      );
      return trigger ?? "none";
    });
  }

  async function loadForUpdate(client: PoolClient, id: string): Promise<ScheduleRow> {
    const found = await client.query<ScheduleRow>(
      "select * from schedules where id = $1 for update",
      [id],
    );
    const row = found.rows[0];
    if (row === undefined) {
      throw new ScheduleNotFoundError(id);
    }
    return row;
  }

  async function tick(): Promise<ScheduleTickReport> {
    const now = clock.now();
    const triggers: ScheduleTrigger[] = [];
    for (;;) {
      const drained = await drainNextBuffer();
      if (drained === undefined) {
        break;
      }
      triggers.push(drained);
    }
    let handled = 0;
    while (handled < batchSize) {
      const outcome = await fireNextDue(now);
      if (outcome === "none") {
        const remaining = await pool.query(
          "select 1 from schedules where state = 'ACTIVE' and next_fire_at <= $1 limit 1",
          [now],
        );
        if (remaining.rowCount === 0) {
          break;
        }
      } else {
        triggers.push(outcome);
      }
      handled += 1;
    }
    return { triggers };
  }

  return {
    async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
      const timeZone = input.timeZone ?? "UTC";
      const parsed = parseCron(input.cronExpression, timeZone);
      const first = nextCronTime(parsed, input.startAt ?? clock.now());
      try {
        const inserted = await pool.query<ScheduleRow>(
          `insert into schedules
             (namespace_id, name, cron_expression, time_zone, workflow_type, input,
              overlap_policy, next_fire_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           returning *`,
          [
            input.namespaceId,
            input.name,
            parsed.expression,
            timeZone,
            input.workflowType,
            JSON.stringify(input.input ?? {}),
            input.overlapPolicy ?? "skip",
            first,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new Error(`insert of schedule "${input.name}" returned no row`);
        }
        return toRecord(row);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === UNIQUE_VIOLATION) {
          throw new ScheduleAlreadyExistsError(input.name);
        }
        throw error;
      }
    },

    async get(id: string): Promise<ScheduleRecord> {
      const found = await pool.query<ScheduleRow>("select * from schedules where id = $1", [id]);
      const row = found.rows[0];
      if (row === undefined) {
        throw new ScheduleNotFoundError(id);
      }
      return toRecord(row);
    },

    async pause(id: string): Promise<ScheduleRecord> {
      return inTransaction(async (client) => {
        await loadForUpdate(client, id);
        const updated = await client.query<ScheduleRow>(
          "update schedules set state = 'PAUSED', updated_at = now() where id = $1 returning *",
          [id],
        );
        return toRecord(requireRow(updated.rows[0], id));
      });
    },

    async resume(id: string): Promise<ScheduleRecord> {
      const now = clock.now();
      return inTransaction(async (client) => {
        const row = await loadForUpdate(client, id);
        const updated = await client.query<ScheduleRow>(
          `update schedules set state = 'ACTIVE', next_fire_at = $2, updated_at = now()
           where id = $1 returning *`,
          [id, nextAfter(row, now)],
        );
        return toRecord(requireRow(updated.rows[0], id));
      });
    },

    tick,

    async catchUp(): Promise<ScheduleTickReport> {
      const triggers: ScheduleTrigger[] = [];
      for (;;) {
        const report = await tick();
        triggers.push(...report.triggers);
        if (report.triggers.length < batchSize) {
          return { triggers };
        }
      }
    },

    async backfill(id: string, from: Date, to: Date): Promise<ScheduleTickReport> {
      const current = await this.get(id);
      const instants = cronTimesBetween(
        parseCron(current.cronExpression, current.timeZone),
        from,
        to,
      );
      const triggers: ScheduleTrigger[] = [];
      for (const scheduledFor of instants) {
        const trigger = await inTransaction(async (client) => {
          const row = await loadForUpdate(client, id);
          return handleTrigger(client, row, scheduledFor);
        });
        if (trigger !== undefined) {
          triggers.push(trigger);
        }
      }
      return { triggers };
    },

    async nextDueAt(): Promise<Date | undefined> {
      const result = await pool.query<{ next: Date | null }>(
        "select min(next_fire_at) as next from schedules where state = 'ACTIVE'",
      );
      return result.rows[0]?.next ?? undefined;
    },
  };
}
