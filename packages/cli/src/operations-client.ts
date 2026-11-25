import { createApiCall, type ApiClientOptions } from "./run-client.ts";

/**
 * What a pause or resume names: a run by id, a queue by name (the api's
 * own queue when left out) or the whole namespace.
 */
export type PauseSubject =
  | { readonly scope: "namespace" }
  | { readonly scope: "queue"; readonly queueName?: string }
  | { readonly scope: "run"; readonly runId: string };

/**
 * A pause as the api reports it.
 */
export interface PauseSnapshot {
  readonly scope: "namespace" | "queue" | "run";
  readonly queueName: string | null;
  readonly runId: string | null;
  readonly reason: string | null;
  readonly pausedAt: string;
}

/**
 * A schedule as the api reports it.
 */
export interface ScheduleSnapshot {
  readonly scheduleId: string;
  readonly name: string;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly workflowType: string;
  readonly input: unknown;
  readonly overlapPolicy: string;
  readonly catchUpPolicy: string;
  readonly state: string;
  readonly error: string | null;
  readonly nextFireAt: string | null;
  readonly lastFiredAt: string | null;
  readonly bufferedFor: string | null;
}

/**
 * One trigger of a schedule as the api reports it.
 */
export interface TriggerSnapshot {
  readonly scheduledFor: string;
  readonly outcome: string;
  readonly runId: string | null;
  readonly cancelledRunIds?: readonly string[];
}

/**
 * What `OperationsClient.createSchedule` sends.
 */
export interface ScheduleDefinition {
  readonly name: string;
  readonly cronExpression: string;
  readonly workflowType: string;
  readonly input?: unknown;
  readonly timeZone?: string;
  readonly overlapPolicy?: string;
  readonly catchUpPolicy?: string;
}

/**
 * A dead letter as the api reports it: a step task that ran out of
 * attempts.
 */
export interface DeadLetterSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempts: number;
  readonly error: { readonly name: string; readonly message: string };
  readonly reason: string;
  readonly createdAt: string;
}

/**
 * A quarantined task as the api reports it.
 */
export interface QuarantinedTaskSnapshot {
  readonly taskId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly taskType: string;
  readonly reclaimCount: number;
  readonly quarantinedAt: string;
  readonly reason: string;
}

/**
 * The operator surface of the api the `wf pause`, `wf resume`,
 * `wf schedule`, `wf dlq` and `wf quarantine` commands use.
 */
export interface OperationsClient {
  pause(
    subject: PauseSubject,
    reason?: string,
  ): Promise<{ readonly pause: PauseSnapshot; readonly created: boolean }>;
  resume(subject: PauseSubject): Promise<boolean>;
  listPauses(): Promise<readonly PauseSnapshot[]>;
  createSchedule(definition: ScheduleDefinition): Promise<ScheduleSnapshot>;
  listSchedules(): Promise<readonly ScheduleSnapshot[]>;
  getSchedule(scheduleId: string): Promise<ScheduleSnapshot>;
  listTriggers(scheduleId: string, limit?: number): Promise<readonly TriggerSnapshot[]>;
  pauseSchedule(scheduleId: string): Promise<ScheduleSnapshot>;
  resumeSchedule(scheduleId: string): Promise<ScheduleSnapshot>;
  backfill(
    scheduleId: string,
    range: { readonly from: string; readonly to: string; readonly overlapPolicy?: string },
  ): Promise<readonly TriggerSnapshot[]>;
  /** Every dead letter of the namespace, oldest first, following the pages. */
  listDeadLetters(): Promise<readonly DeadLetterSnapshot[]>;
  /** Requeues a dead letter and resolves with the new task id. */
  requeueDeadLetter(deadLetterId: string): Promise<string>;
  listQuarantined(): Promise<readonly QuarantinedTaskSnapshot[]>;
  /** Releases a quarantined task and resolves with its run id. */
  releaseQuarantined(taskId: string): Promise<string>;
}

const MAX_DEAD_LETTER_PAGES = 100;

function scheduleIdPath(scheduleId: string, suffix = ""): string {
  return `/v1/schedules/${encodeURIComponent(scheduleId)}${suffix}`;
}

/**
 * Creates an `OperationsClient` for the http api at `options.baseUrl`.
 */
export function createOperationsClient(options: ApiClientOptions): OperationsClient {
  const call = createApiCall(options);

  return {
    async pause(subject, reason) {
      return (await call("POST", "/v1/pauses", {
        ...subject,
        ...(reason === undefined ? {} : { reason }),
      })) as { pause: PauseSnapshot; created: boolean };
    },
    async resume(subject) {
      const answer = (await call("POST", "/v1/pauses/resume", subject)) as { resumed: boolean };
      return answer.resumed;
    },
    async listPauses() {
      return ((await call("GET", "/v1/pauses")) as { pauses: PauseSnapshot[] }).pauses;
    },
    async createSchedule(definition) {
      return (await call("POST", "/v1/schedules", definition)) as ScheduleSnapshot;
    },
    async listSchedules() {
      return ((await call("GET", "/v1/schedules")) as { schedules: ScheduleSnapshot[] }).schedules;
    },
    async getSchedule(scheduleId) {
      return (await call("GET", scheduleIdPath(scheduleId))) as ScheduleSnapshot;
    },
    async listTriggers(scheduleId, limit) {
      const query = limit === undefined ? "" : `?limit=${String(limit)}`;
      const answer = (await call("GET", scheduleIdPath(scheduleId, `/triggers${query}`))) as {
        triggers: TriggerSnapshot[];
      };
      return answer.triggers;
    },
    async pauseSchedule(scheduleId) {
      return (await call("POST", scheduleIdPath(scheduleId, "/pause"))) as ScheduleSnapshot;
    },
    async resumeSchedule(scheduleId) {
      return (await call("POST", scheduleIdPath(scheduleId, "/resume"))) as ScheduleSnapshot;
    },
    async backfill(scheduleId, range) {
      const answer = (await call("POST", scheduleIdPath(scheduleId, "/backfill"), range)) as {
        triggers: TriggerSnapshot[];
      };
      return answer.triggers;
    },
    async listDeadLetters() {
      const letters: DeadLetterSnapshot[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_DEAD_LETTER_PAGES; page += 1) {
        const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
        const answer = (await call("GET", `/v1/dead-letters${query}`)) as {
          deadLetters: DeadLetterSnapshot[];
          nextCursor?: string;
        };
        letters.push(...answer.deadLetters);
        cursor = answer.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
      return letters;
    },
    async requeueDeadLetter(deadLetterId) {
      const answer = (await call(
        "POST",
        `/v1/dead-letters/${encodeURIComponent(deadLetterId)}/requeue`,
        {},
      )) as { taskId: string };
      return answer.taskId;
    },
    async listQuarantined() {
      return ((await call("GET", "/v1/quarantined-tasks")) as { tasks: QuarantinedTaskSnapshot[] })
        .tasks;
    },
    async releaseQuarantined(taskId) {
      const answer = (await call(
        "POST",
        `/v1/quarantined-tasks/${encodeURIComponent(taskId)}/release`,
        {},
      )) as { runId: string };
      return answer.runId;
    },
  };
}
