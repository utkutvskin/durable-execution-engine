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
 * The operator surface of the api the `wf pause`, `wf resume` and
 * `wf schedule` commands use.
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
}

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
  };
}
