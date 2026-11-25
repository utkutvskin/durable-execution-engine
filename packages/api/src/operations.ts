import {
  ScheduleNotFoundError,
  createJanitor,
  createPauseControl,
  createScheduleManager,
  cronTimesBetween,
  parseCron,
  systemClock,
  type CatchUpPolicy,
  type ClockSource,
  type OverlapPolicy,
  type PauseRecord,
  type PauseScope,
  type PauseTarget,
  type Pool,
  type QuarantinedTask,
  type ScheduleRecord,
  type ScheduleTrigger,
  type ScheduleTriggerRecord,
} from "@dee/core";

/**
 * The most triggers one backfill request may cover. A wider range is
 * refused with `BackfillTooLargeError`, so a mistyped range cannot start
 * thousands of runs at once.
 */
export const MAX_BACKFILL_TRIGGERS = 1000;

/**
 * Raised when a backfill range holds more than `MAX_BACKFILL_TRIGGERS`
 * triggers or ends before it starts.
 */
export class InvalidBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBackfillError";
  }
}

/**
 * Raised when a quarantined task does not exist in the caller's namespace,
 * or was released already.
 */
export class QuarantinedTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`quarantined task ${taskId} not found`);
    this.name = "QuarantinedTaskNotFoundError";
  }
}

/**
 * A quarantined task as the api shows it: a task that is never delivered
 * again until an operator releases it.
 */
export interface QuarantinedTaskDescription {
  readonly taskId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly taskType: string;
  readonly reclaimCount: number;
  readonly quarantinedAt: string;
  readonly reason: string;
}

/**
 * A pause as the api shows it. `queueName` is set for a queue pause and
 * `runId` for a run pause.
 */
export interface PauseDescription {
  readonly scope: PauseScope;
  readonly queueName: string | null;
  readonly runId: string | null;
  readonly reason: string | null;
  readonly pausedAt: string;
}

/**
 * What a pause or resume request names. A queue pause without `queueName`
 * means the api's own queue.
 */
export interface PauseRequest {
  readonly scope: PauseScope;
  readonly queueName?: string | undefined;
  readonly runId?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * A schedule as the api shows it, with instants as ISO strings.
 */
export interface ScheduleDescription {
  readonly scheduleId: string;
  readonly name: string;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly workflowType: string;
  readonly input: unknown;
  readonly overlapPolicy: OverlapPolicy;
  readonly catchUpPolicy: CatchUpPolicy;
  readonly catchUpWindowMs: number | null;
  readonly state: "ACTIVE" | "PAUSED" | "ERRORED";
  readonly error: string | null;
  readonly queueName: string;
  readonly nextFireAt: string | null;
  readonly lastFiredAt: string | null;
  readonly bufferedFor: string | null;
}

/**
 * What `POST /v1/schedules` takes.
 */
export interface CreateScheduleRequest {
  readonly name: string;
  readonly cronExpression: string;
  readonly workflowType: string;
  readonly input?: unknown;
  readonly timeZone?: string | undefined;
  readonly overlapPolicy?: OverlapPolicy | undefined;
  readonly catchUpPolicy?: CatchUpPolicy | undefined;
  readonly catchUpWindowMs?: number | undefined;
  readonly startAt?: string | undefined;
}

/**
 * One trigger of a schedule as the api shows it. `cancelledRunIds` is set
 * by a `cancel_other` trigger.
 */
export interface TriggerDescription {
  readonly scheduledFor: string;
  readonly outcome: "STARTED" | "SKIPPED" | "BUFFERED";
  readonly runId: string | null;
  readonly cancelledRunIds?: readonly string[];
}

/**
 * What `POST /v1/schedules/{scheduleId}/backfill` takes: the range
 * `[from, to)` and an optional overlap policy for its triggers.
 */
export interface BackfillRequest {
  readonly from: string;
  readonly to: string;
  readonly overlapPolicy?: OverlapPolicy | undefined;
}

/**
 * The operator operations of the api: pausing work and managing schedules.
 * Every method is scoped to the caller's namespace; a schedule of another
 * namespace is reported as `ScheduleNotFoundError`.
 */
export interface Operations {
  /** Pauses a run, a queue or the namespace. Resolves whether this call created the pause. */
  pause(
    namespaceId: string,
    request: PauseRequest,
  ): Promise<{ readonly pause: PauseDescription; readonly created: boolean }>;

  /** Resumes a run, a queue or the namespace. Resolves whether a pause was removed. */
  resume(namespaceId: string, request: PauseRequest): Promise<{ readonly resumed: boolean }>;

  /** Lists the namespace's pauses, oldest first. */
  listPauses(namespaceId: string): Promise<readonly PauseDescription[]>;

  /** The pauses holding back a run, its own first. */
  pausesOfRun(namespaceId: string, runId: string): Promise<readonly PauseDescription[]>;

  /** Creates a schedule on the api's queue. */
  createSchedule(namespaceId: string, request: CreateScheduleRequest): Promise<ScheduleDescription>;

  /** Lists the namespace's schedules by name. */
  listSchedules(namespaceId: string): Promise<readonly ScheduleDescription[]>;

  /** Reads one schedule. */
  getSchedule(namespaceId: string, scheduleId: string): Promise<ScheduleDescription>;

  /** Reads the latest triggers of a schedule, newest first. */
  listScheduleTriggers(
    namespaceId: string,
    scheduleId: string,
    limit?: number,
  ): Promise<readonly TriggerDescription[]>;

  /** Pauses a schedule. */
  pauseSchedule(namespaceId: string, scheduleId: string): Promise<ScheduleDescription>;

  /** Resumes a schedule from the next match after now. */
  resumeSchedule(namespaceId: string, scheduleId: string): Promise<ScheduleDescription>;

  /**
   * Handles every trigger of `[from, to)` once. Repeating it starts nothing
   * new. Rejects with `InvalidBackfillError` for an empty, reversed or too
   * wide range.
   */
  backfillSchedule(
    namespaceId: string,
    scheduleId: string,
    request: BackfillRequest,
  ): Promise<readonly TriggerDescription[]>;

  /** Lists the namespace's quarantined tasks, oldest first. */
  listQuarantinedTasks(namespaceId: string): Promise<readonly QuarantinedTaskDescription[]>;

  /**
   * Puts a quarantined task back on its queue with a fresh reclaim budget.
   * Rejects with `QuarantinedTaskNotFoundError`.
   */
  releaseQuarantinedTask(
    namespaceId: string,
    taskId: string,
  ): Promise<{ readonly taskId: string; readonly runId: string }>;
}

/**
 * Options for `createOperations`: the api's queue, which new schedules and
 * a queue pause without a name use, and the clock schedules read "now" from.
 */
export interface OperationsOptions {
  readonly queueName: string;
  readonly clock?: ClockSource;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describePause(pause: PauseRecord): PauseDescription {
  return {
    scope: pause.scope,
    queueName: pause.queueName,
    runId: pause.runId,
    reason: pause.reason,
    pausedAt: pause.pausedAt.toISOString(),
  };
}

function describeQuarantined(task: QuarantinedTask): QuarantinedTaskDescription {
  return {
    taskId: task.taskId,
    runId: task.runId,
    queueName: task.queueName,
    taskType: task.taskType,
    reclaimCount: task.reclaimCount,
    quarantinedAt: task.quarantinedAt.toISOString(),
    reason: task.reason,
  };
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function describeSchedule(schedule: ScheduleRecord): ScheduleDescription {
  return {
    scheduleId: schedule.id,
    name: schedule.name,
    cronExpression: schedule.cronExpression,
    timeZone: schedule.timeZone,
    workflowType: schedule.workflowType,
    input: schedule.input,
    overlapPolicy: schedule.overlapPolicy,
    catchUpPolicy: schedule.catchUpPolicy,
    catchUpWindowMs: schedule.catchUpWindowMs,
    state: schedule.state,
    error: schedule.error,
    queueName: schedule.queueName,
    nextFireAt: iso(schedule.nextFireAt),
    lastFiredAt: iso(schedule.lastFiredAt),
    bufferedFor: iso(schedule.bufferedFor),
  };
}

function describeTrigger(trigger: ScheduleTrigger): TriggerDescription {
  return {
    scheduledFor: trigger.scheduledFor.toISOString(),
    outcome: trigger.outcome,
    runId: trigger.runId ?? null,
    ...(trigger.cancelledRunIds === undefined ? {} : { cancelledRunIds: trigger.cancelledRunIds }),
  };
}

function describeStoredTrigger(trigger: ScheduleTriggerRecord): TriggerDescription {
  return {
    scheduledFor: trigger.scheduledFor.toISOString(),
    outcome: trigger.outcome,
    runId: trigger.runId,
  };
}

/**
 * Creates the api's `Operations` over `pool`.
 */
export function createOperations(pool: Pool, options: OperationsOptions): Operations {
  const pauses = createPauseControl(pool);
  const schedules = createScheduleManager(pool, {
    queueName: options.queueName,
    clock: options.clock ?? systemClock,
  });
  const janitor = createJanitor(pool, options.clock === undefined ? {} : { clock: options.clock });

  function targetOf(namespaceId: string, request: PauseRequest): PauseTarget {
    if (request.scope === "run") {
      return { scope: "run", namespaceId, runId: request.runId ?? "" };
    }
    if (request.scope === "queue") {
      return { scope: "queue", namespaceId, queueName: request.queueName ?? options.queueName };
    }
    return { scope: "namespace", namespaceId };
  }

  async function ownedSchedule(namespaceId: string, scheduleId: string): Promise<ScheduleRecord> {
    if (!UUID_PATTERN.test(scheduleId)) {
      throw new ScheduleNotFoundError(scheduleId);
    }
    const schedule = await schedules.get(scheduleId);
    if (schedule.namespaceId !== namespaceId) {
      throw new ScheduleNotFoundError(scheduleId);
    }
    return schedule;
  }

  return {
    async pause(namespaceId, request) {
      const receipt = await pauses.pause(targetOf(namespaceId, request), request.reason);
      return { pause: describePause(receipt.pause), created: receipt.created };
    },

    async resume(namespaceId, request) {
      return { resumed: await pauses.resume(targetOf(namespaceId, request)) };
    },

    async listPauses(namespaceId) {
      return (await pauses.list(namespaceId)).map(describePause);
    },

    async pausesOfRun(namespaceId, runId) {
      return (await pauses.pausesOfRun(namespaceId, runId)).map(describePause);
    },

    async createSchedule(namespaceId, request) {
      const created = await schedules.create({
        namespaceId,
        name: request.name,
        cronExpression: request.cronExpression,
        workflowType: request.workflowType,
        input: request.input ?? {},
        ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
        ...(request.overlapPolicy === undefined ? {} : { overlapPolicy: request.overlapPolicy }),
        ...(request.catchUpPolicy === undefined ? {} : { catchUpPolicy: request.catchUpPolicy }),
        ...(request.catchUpWindowMs === undefined
          ? {}
          : { catchUpWindowMs: request.catchUpWindowMs }),
        ...(request.startAt === undefined ? {} : { startAt: new Date(request.startAt) }),
      });
      return describeSchedule(created);
    },

    async listSchedules(namespaceId) {
      return (await schedules.list(namespaceId)).map(describeSchedule);
    },

    async getSchedule(namespaceId, scheduleId) {
      return describeSchedule(await ownedSchedule(namespaceId, scheduleId));
    },

    async listScheduleTriggers(namespaceId, scheduleId, limit) {
      await ownedSchedule(namespaceId, scheduleId);
      return (await schedules.listTriggers(scheduleId, limit)).map(describeStoredTrigger);
    },

    async pauseSchedule(namespaceId, scheduleId) {
      await ownedSchedule(namespaceId, scheduleId);
      return describeSchedule(await schedules.pause(scheduleId));
    },

    async resumeSchedule(namespaceId, scheduleId) {
      await ownedSchedule(namespaceId, scheduleId);
      return describeSchedule(await schedules.resume(scheduleId));
    },

    async backfillSchedule(namespaceId, scheduleId, request) {
      const schedule = await ownedSchedule(namespaceId, scheduleId);
      const from = new Date(request.from);
      const to = new Date(request.to);
      if (to.getTime() <= from.getTime()) {
        throw new InvalidBackfillError("a backfill range must end after it starts");
      }
      const instants = cronTimesBetween(
        parseCron(schedule.cronExpression, schedule.timeZone),
        from,
        to,
        MAX_BACKFILL_TRIGGERS + 1,
      );
      if (instants.length > MAX_BACKFILL_TRIGGERS) {
        throw new InvalidBackfillError(
          `a backfill may cover at most ${String(MAX_BACKFILL_TRIGGERS)} triggers; split the range`,
        );
      }
      const report = await schedules.backfill(scheduleId, from, to, {
        ...(request.overlapPolicy === undefined ? {} : { overlapPolicy: request.overlapPolicy }),
      });
      return report.triggers.map(describeTrigger);
    },

    async listQuarantinedTasks(namespaceId) {
      return (await janitor.listQuarantined(namespaceId)).map(describeQuarantined);
    },

    async releaseQuarantinedTask(namespaceId, taskId) {
      if (!UUID_PATTERN.test(taskId)) {
        throw new QuarantinedTaskNotFoundError(taskId);
      }
      const owned = await pool.query<{ run_id: string }>(
        "select run_id from tasks where id = $1 and namespace_id = $2 and state = 'QUARANTINED'",
        [taskId, namespaceId],
      );
      const runId = owned.rows[0]?.run_id;
      if (runId === undefined || !(await janitor.releaseQuarantined(taskId, namespaceId))) {
        throw new QuarantinedTaskNotFoundError(taskId);
      }
      return { taskId, runId };
    },
  };
}
