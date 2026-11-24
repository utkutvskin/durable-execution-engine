import type { Pool, PoolClient } from "pg";
import { CURRENT_EVENT_VERSION } from "../event-store/event-version.ts";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import { systemClock, type ClockSource } from "../workflow/sources.ts";
import { noopTracing, type Tracing } from "../observability/tracing.ts";
import { createMonotonicClock } from "./monotonic-clock.ts";
import { rollbackQuietly } from "../db/transaction.ts";
import { isTimeoutTimerId, timeOutRunOnClient } from "../timeouts/run-timeouts.ts";

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
 * Options for `createTimerScheduler`. The scheduler fires only the timers of
 * runs that belong to `queueName`, and the `WORKFLOW_TASK` of a fired timer
 * goes to that run's queue. `batchSize` bounds how many
 * timers one tick fires (default 100).
 */
export interface TimerSchedulerOptions {
  readonly queueName: string;
  readonly clock?: ClockSource;
  readonly codec?: Codec;
  readonly batchSize?: number;
  readonly tracing?: Tracing;
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
   * id), as one batch in one transaction: it appends a `timer_fired` per
   * timer to its run's log, marks the timers fired and enqueues one
   * `WORKFLOW_TASK` per run whose `visible_at` is the earliest `fireAt`,
   * so tasks are delivered in the order the timers came due. A due run
   * timeout timer is fired in a transaction of its own. Concurrent ticks
   * never fire a timer twice.
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
  created_at: Date;
}

const DEFAULT_BATCH_SIZE = 100;

interface LockedRunRow {
  id: string;
  namespace_id: string;
  status: string;
  traceparent: string | null;
  queue_name: string;
  current_seq: string;
}

interface BatchOutcome {
  readonly fired: readonly FiredTimer[];
  readonly cancelled: number;
  readonly traces: readonly {
    readonly timer: DueTimerRow;
    readonly traceparent: string | null | undefined;
  }[];
}

async function enqueueTimerTasks(
  client: PoolClient,
  timers: readonly DueTimerRow[],
  runsById: ReadonlyMap<string, LockedRunRow>,
): Promise<Map<string, string>> {
  if (timers.length === 0) {
    return new Map();
  }
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
     select batch.namespace_id, batch.run_id, batch.queue_name, 'WORKFLOW_TASK',
            batch.payload::jsonb, batch.visible_at
     from unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::timestamptz[])
       as batch (namespace_id, run_id, queue_name, payload, visible_at)`,
    [
      timers.map((timer) => runsById.get(timer.run_id)?.namespace_id ?? null),
      timers.map((timer) => timer.run_id),
      timers.map((timer) => runsById.get(timer.run_id)?.queue_name ?? null),
      timers.map((timer) => JSON.stringify({ reason: "timer_fired", timerId: timer.timer_id })),
      timers.map((timer) => timer.fire_at),
    ],
  );
  const pending = await client.query<{ id: string; run_id: string }>(
    `select id, run_id from tasks
     where run_id = any($1::uuid[]) and task_type = 'WORKFLOW_TASK' and state = 'PENDING'`,
    [timers.map((timer) => timer.run_id)],
  );
  return new Map(pending.rows.map((row) => [row.run_id, row.id]));
}

function timeoutFiredTimer(timer: DueTimerRow, now: Date): FiredTimer {
  return {
    runId: timer.run_id,
    timerId: timer.timer_id,
    fireAt: timer.fire_at,
    firedAt: now,
    lateMs: Math.max(0, now.getTime() - timer.fire_at.getTime()),
    taskId: "",
  };
}

/**
 * Creates a `TimerScheduler` over `pool`. The clock is wrapped in a
 * monotonic clock, so a wall clock stepped backwards can delay a timer but
 * never reverse a decision that was already taken.
 */
export function createTimerScheduler(pool: Pool, options: TimerSchedulerOptions): TimerScheduler {
  const clock = createMonotonicClock(options.clock ?? systemClock);
  const codec = options.codec ?? jsonCodec;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const tracing = options.tracing ?? noopTracing;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`batchSize must be a positive integer, got ${String(batchSize)}`);
  }

  async function fireTimeout(
    client: PoolClient,
    timer: DueTimerRow,
    now: Date,
  ): Promise<FiredTimer | "cancelled"> {
    const closed = await timeOutRunOnClient(client, codec, timer.run_id, timer.timer_id);
    await client.query("update timers set state = $3, fired_at = $2 where id = $1", [
      timer.id,
      now,
      closed ? "FIRED" : "CANCELLED",
    ]);
    return closed ? timeoutFiredTimer(timer, now) : "cancelled";
  }

  async function fireWorkflowTimers(
    client: PoolClient,
    timers: readonly DueTimerRow[],
    now: Date,
  ): Promise<BatchOutcome> {
    const runIds = [...new Set(timers.map((timer) => timer.run_id))].sort();
    const runs = await client.query<LockedRunRow>(
      `select r.id, r.namespace_id, r.status, r.traceparent, r.queue_name,
              greatest(
                run_event_sequence(r.id),
                coalesce((select s.last_sequence_number from run_snapshots s where s.run_id = r.id), 0)
              ) as current_seq
       from workflow_runs r
       where r.id = any($1::uuid[])
       order by r.id
       for no key update of r`,
      [runIds],
    );
    const runsById = new Map(runs.rows.map((run) => [run.id, run]));
    const live = timers.filter((timer) => runsById.get(timer.run_id)?.status === "RUNNING");
    const dead = timers.filter((timer) => runsById.get(timer.run_id)?.status !== "RUNNING");
    const nextSeq = new Map(runs.rows.map((run) => [run.id, Number(run.current_seq)]));
    const sequences = live.map((timer) => {
      const sequence = (nextSeq.get(timer.run_id) ?? 0) + 1;
      nextSeq.set(timer.run_id, sequence);
      return sequence;
    });
    if (live.length > 0) {
      await client.query(
        `insert into run_events
           (run_id, sequence_number, event_type, payload, event_version, run_created_at)
         select batch.run_id, batch.sequence_number, 'timer_fired', batch.payload::jsonb, $4,
                run.created_at
         from unnest($1::uuid[], $2::bigint[], $3::text[])
           as batch (run_id, sequence_number, payload)
         join workflow_runs run on run.id = batch.run_id`,
        [
          live.map((timer) => timer.run_id),
          sequences,
          live.map((timer) => codec.encode({ type: "timer_fired", timerId: timer.timer_id })),
          CURRENT_EVENT_VERSION,
        ],
      );
    }
    await client.query(
      `update timers set state = batch.state, fired_at = $3
       from unnest($1::uuid[], $2::text[]) as batch (id, state)
       where timers.id = batch.id`,
      [
        [...live, ...dead].map((timer) => timer.id),
        [...live.map(() => "FIRED"), ...dead.map(() => "CANCELLED")],
        now,
      ],
    );
    const firstByRun = new Map<string, DueTimerRow>();
    live.forEach((timer) => {
      if (!firstByRun.has(timer.run_id)) {
        firstByRun.set(timer.run_id, timer);
      }
    });
    const taskIds = await enqueueTimerTasks(client, [...firstByRun.values()], runsById);
    return {
      fired: live.map((timer) => ({
        runId: timer.run_id,
        timerId: timer.timer_id,
        fireAt: timer.fire_at,
        firedAt: now,
        lateMs: Math.max(0, now.getTime() - timer.fire_at.getTime()),
        taskId: taskIds.get(timer.run_id) ?? "",
      })),
      cancelled: dead.length,
      traces: live.map((timer) => ({
        timer,
        traceparent: runsById.get(timer.run_id)?.traceparent,
      })),
    };
  }

  async function fireBatch(now: Date, limit: number): Promise<BatchOutcome | undefined> {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      const due = await client.query<DueTimerRow>(
        `select timers.id, timers.run_id, timers.timer_id, timers.fire_at, timers.created_at
         from timers
         join workflow_runs r on r.id = timers.run_id
         where timers.state = 'PENDING' and timers.fire_at <= $1 and r.queue_name = $2
         order by timers.fire_at, timers.id
         limit $3
         for update of timers skip locked`,
        [now, options.queueName, limit],
      );
      const first = due.rows[0];
      if (first === undefined) {
        await client.query("commit");
        return undefined;
      }
      let outcome: BatchOutcome;
      if (isTimeoutTimerId(first.timer_id)) {
        const fired = await fireTimeout(client, first, now);
        outcome =
          fired === "cancelled"
            ? { fired: [], cancelled: 1, traces: [] }
            : { fired: [fired], cancelled: 0, traces: [] };
      } else {
        const cut = due.rows.findIndex((timer) => isTimeoutTimerId(timer.timer_id));
        const batch = cut < 0 ? due.rows : due.rows.slice(0, cut);
        outcome = await fireWorkflowTimers(client, batch, now);
      }
      await client.query("commit");
      outcome.traces.forEach(({ timer, traceparent }) => {
        const span = tracing.startSpan(`timer ${timer.timer_id}`, {
          parent: traceparent ?? null,
          startTime: timer.created_at,
          attributes: {
            "dee.run.id": timer.run_id,
            "dee.timer.id": timer.timer_id,
            "dee.timer.late_ms": Math.max(0, now.getTime() - timer.fire_at.getTime()),
          },
        });
        span.end(now);
      });
      return outcome;
    } catch (error) {
      broken = !(await rollbackQuietly(client));
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async function tick(): Promise<TickReport> {
    const now = clock.now();
    const fired: FiredTimer[] = [];
    let cancelled = 0;
    while (fired.length + cancelled < batchSize) {
      const outcome = await fireBatch(now, batchSize - fired.length - cancelled);
      if (outcome === undefined) {
        break;
      }
      fired.push(...outcome.fired);
      cancelled += outcome.cancelled;
    }
    return { fired, cancelled };
  }

  return {
    async schedule(input: ScheduleTimerInput): Promise<boolean> {
      const client = await pool.connect();
      let broken = false;
      try {
        return await insertTimerOnClient(client, input);
      } catch (error) {
        broken = true;
        throw error;
      } finally {
        client.release(broken);
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
