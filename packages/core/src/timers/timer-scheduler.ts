import type { Pool, PoolClient } from "pg";
import { appendEventsOnClient, readCurrentSequenceOnClient } from "../event-store/event-store.js";
import { jsonCodec, type Codec } from "../event-store/codec.js";
import { systemClock, type ClockSource } from "../workflow/sources.js";
import { createMonotonicClock } from "./monotonic-clock.js";

/**
 * What `TimerScheduler.schedule` needs: the run and timer id the decision
 * gave the timer, and when it is due.
 */
export interface ScheduleTimerInput {
  readonly runId: string;
  readonly timerId: string;
  readonly fireAt: Date;
}

/**
 * A timer that was fired by a tick. `lateMs` is how long after `fireAt` it
 * was fired; it is large for timers that came due while the engine was down.
 */
export interface FiredTimer {
  readonly runId: string;
  readonly timerId: string;
  readonly fireAt: Date;
  readonly firedAt: Date;
  readonly lateMs: number;
  readonly taskId: string;
}

/**
 * What one tick did. `fired` is in firing order. `cancelled` counts due
 * timers whose run had already ended: they are closed without an event or
 * a task.
 */
export interface TickReport {
  readonly fired: readonly FiredTimer[];
  readonly cancelled: number;
}

/**
 * What `TimerScheduler.catchUp` did across all of its ticks.
 */
export interface CatchUpReport extends TickReport {
  readonly ticks: number;
}

/**
 * Options for `createTimerScheduler`. `queueName` is the queue the
 * `WORKFLOW_TASK` of a fired timer goes to. `batchSize` bounds how many
 * timers one tick fires (default 100).
 */
export interface TimerSchedulerOptions {
  readonly queueName: string;
  readonly clock?: ClockSource;
  readonly codec?: Codec;
  readonly batchSize?: number;
}

/**
 * Keeps durable timers in postgres and turns the ones that come due into
 * workflow tasks. All state is in the database, so a new instance after a
 * restart picks up exactly where the old one stopped.
 */
export interface TimerScheduler {
  /**
   * Records a timer. Scheduling the same `(runId, timerId)` again does
   * nothing and resolves `false`.
   */
  schedule(input: ScheduleTimerInput): Promise<boolean>;

  /**
   * Fires up to `batchSize` due timers, earliest `fireAt` first (ties by
   * id). Each firing is one transaction: it appends `timer_fired` to the
   * run's log, marks the timer fired and enqueues a `WORKFLOW_TASK` whose
   * `visible_at` is the timer's `fireAt`, so tasks are delivered in the
   * order the timers came due. Concurrent ticks never fire a timer twice.
   */
  tick(): Promise<TickReport>;

  /**
   * Ticks until nothing is due. This is what a starting engine runs to
   * process every timer that came due while it was down.
   */
  catchUp(): Promise<CatchUpReport>;

  /** The earliest `fireAt` among pending timers, if any. */
  nextDueAt(): Promise<Date | undefined>;

  /** How many readings of the system clock went backwards so far. */
  readonly clockRegressions: number;
}

/**
 * Inserts a pending timer on `client`, inside a transaction the caller
 * owns, so a timer row can be written atomically with the `timer_started`
 * event that announces it. Resolves `false` when the timer already exists.
 */
export async function insertTimerOnClient(
  client: PoolClient,
  input: ScheduleTimerInput,
): Promise<boolean> {
  const result = await client.query(
    `insert into timers (run_id, timer_id, fire_at)
     values ($1, $2, $3)
     on conflict (run_id, timer_id) do nothing`,
    [input.runId, input.timerId, input.fireAt],
  );
  return result.rowCount === 1;
}

interface DueTimerRow {
  id: string;
  run_id: string;
  timer_id: string;
  fire_at: Date;
}

const DEFAULT_BATCH_SIZE = 100;

/**
 * Creates a `TimerScheduler` over `pool`. The clock is wrapped in a
 * monotonic clock, so a wall clock stepped backwards can delay a timer but
 * never reverse a decision that was already taken.
 */
export function createTimerScheduler(pool: Pool, options: TimerSchedulerOptions): TimerScheduler {
  const clock = createMonotonicClock(options.clock ?? systemClock);
  const codec = options.codec ?? jsonCodec;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`batchSize must be a positive integer, got ${String(batchSize)}`);
  }

  async function fireNext(now: Date): Promise<FiredTimer | "cancelled" | undefined> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const due = await client.query<DueTimerRow>(
        `select id, run_id, timer_id, fire_at from timers
         where state = 'PENDING' and fire_at <= $1
         order by fire_at, id
         limit 1
         for update skip locked`,
        [now],
      );
      const timer = due.rows[0];
      if (timer === undefined) {
        await client.query("commit");
        return undefined;
      }
      const run = await client.query<{ namespace_id: string; status: string }>(
        "select namespace_id, status from workflow_runs where id = $1 for update",
        [timer.run_id],
      );
      const runRow = run.rows[0];
      if (runRow?.status !== "RUNNING") {
        await client.query("update timers set state = 'CANCELLED', fired_at = $2 where id = $1", [
          timer.id,
          now,
        ]);
        await client.query("commit");
        return "cancelled";
      }
      const currentSeq = await readCurrentSequenceOnClient(client, timer.run_id);
      await appendEventsOnClient(client, codec, timer.run_id, currentSeq, [
        { type: "timer_fired", timerId: timer.timer_id },
      ]);
      await client.query("update timers set state = 'FIRED', fired_at = $2 where id = $1", [
        timer.id,
        now,
      ]);
      const task = await client.query<{ id: string }>(
        `insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
         values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb, $5)
         returning id`,
        [
          runRow.namespace_id,
          timer.run_id,
          options.queueName,
          JSON.stringify({ reason: "timer_fired", timerId: timer.timer_id }),
          timer.fire_at,
        ],
      );
      await client.query("commit");
      return {
        runId: timer.run_id,
        timerId: timer.timer_id,
        fireAt: timer.fire_at,
        firedAt: now,
        lateMs: Math.max(0, now.getTime() - timer.fire_at.getTime()),
        taskId: task.rows[0]?.id ?? "",
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function tick(): Promise<TickReport> {
    const now = clock.now();
    const fired: FiredTimer[] = [];
    let cancelled = 0;
    while (fired.length + cancelled < batchSize) {
      const outcome = await fireNext(now);
      if (outcome === undefined) {
        break;
      }
      if (outcome === "cancelled") {
        cancelled += 1;
      } else {
        fired.push(outcome);
      }
    }
    return { fired, cancelled };
  }

  return {
    async schedule(input: ScheduleTimerInput): Promise<boolean> {
      const client = await pool.connect();
      try {
        return await insertTimerOnClient(client, input);
      } finally {
        client.release();
      }
    },

    tick,

    async catchUp(): Promise<CatchUpReport> {
      const fired: FiredTimer[] = [];
      let cancelled = 0;
      let ticks = 0;
      for (;;) {
        const report = await tick();
        ticks += 1;
        fired.push(...report.fired);
        cancelled += report.cancelled;
        if (report.fired.length + report.cancelled < batchSize) {
          return { fired, cancelled, ticks };
        }
      }
    },

    async nextDueAt(): Promise<Date | undefined> {
      const result = await pool.query<{ fire_at: Date | null }>(
        "select min(fire_at) as fire_at from timers where state = 'PENDING'",
      );
      return result.rows[0]?.fire_at ?? undefined;
    },

    get clockRegressions(): number {
      return clock.regressions;
    },
  };
}
