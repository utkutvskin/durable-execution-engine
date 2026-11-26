import { buildListQuery, type ListFilters } from "./query.js";
import { createSseParser } from "./sse.js";
import type { HistoryEntry } from "./timeline.js";

/**
 * A non 2xx answer of the api.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * A run as the list shows it.
 */
export interface RunSummary {
  readonly runId: string;
  readonly workflowType: string;
  readonly status: string;
  readonly startedAt: string;
  readonly closedAt: string | null;
  readonly searchAttributes?: Readonly<Record<string, string | number | boolean>>;
  readonly memo?: unknown;
}

/**
 * A run with its input, result and error.
 */
export interface RunDescription extends RunSummary {
  readonly input: unknown;
  readonly result: unknown;
  readonly error: { readonly name: string; readonly message: string } | null;
  readonly lastSequenceNumber: number;
  readonly concurrency?: RunConcurrency;
  readonly paused?: readonly Pause[];
}

/**
 * A pause that holds back work: a run's own, a queue's or the namespace's.
 */
export interface Pause {
  readonly scope: "namespace" | "queue" | "run";
  readonly queueName: string | null;
  readonly runId: string | null;
  readonly reason: string | null;
  readonly pausedAt: string;
}

/**
 * What a pause or resume names. A queue without a name is the api's queue.
 */
export type PauseSubject =
  | { readonly scope: "namespace" }
  | { readonly scope: "queue"; readonly queueName?: string }
  | { readonly scope: "run"; readonly runId: string };

/**
 * A cron schedule as the schedules page shows it.
 */
export interface Schedule {
  readonly scheduleId: string;
  readonly name: string;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly workflowType: string;
  readonly overlapPolicy: string;
  readonly state: "ACTIVE" | "PAUSED" | "ERRORED";
  readonly error: string | null;
  readonly nextFireAt: string | null;
  readonly lastFiredAt: string | null;
}

/**
 * One trigger of a schedule and what became of it.
 */
export interface ScheduleTrigger {
  readonly scheduledFor: string;
  readonly outcome: "STARTED" | "SKIPPED" | "BUFFERED";
  readonly runId: string | null;
}

/**
 * The concurrency key of a run whose workflow has one, as the api describes
 * it: the key, its limit, how many runs hold a slot, whether this run holds
 * one and whether it has work waiting for one.
 */
export interface RunConcurrency {
  readonly key: string;
  readonly limit: number;
  readonly holders: number;
  readonly holdsSlot: boolean;
  readonly waitingForSlot: boolean;
}

/**
 * One page of the run list.
 */
export interface RunPage {
  readonly runs: readonly RunSummary[];
  readonly nextCursor?: string;
}

/**
 * A step task waiting in the dead letter queue.
 */
export interface DeadLetter {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempts: number;
  readonly error: { readonly name: string; readonly message: string };
  readonly reason: string;
  readonly createdAt: string;
}

/**
 * A task that is no longer delivered until an operator releases it.
 */
export interface QuarantinedTask {
  readonly taskId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly taskType: string;
  readonly reclaimCount: number;
  readonly quarantinedAt: string;
  readonly reason: string;
}

/**
 * What the api reports for an update: `completed` with its result, `failed`
 * with what the handler threw, or `accepted` when the wait ended first.
 */
export interface UpdateAnswer {
  readonly status: "completed" | "failed" | "accepted";
  readonly updateId: string;
  readonly sequenceNumber: number;
  readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

/**
 * What the run stream delivers: new events and the run status after them.
 */
export interface StreamSlice {
  readonly events: readonly HistoryEntry[];
  readonly status: string;
  readonly closed: boolean;
}

/**
 * The calls the ui makes. Every call carries the api key of the namespace
 * the user signed in with.
 */
export interface ApiClient {
  namespace(): Promise<{ readonly id: string; readonly name: string }>;
  listRuns(filters: ListFilters, limit: number, cursor?: string): Promise<RunPage>;
  describeRun(runId: string): Promise<RunDescription>;
  /** Decodes stored payloads through the codec endpoint, in order. */
  decodePayloads(payloads: readonly unknown[]): Promise<unknown[]>;
  signalRun(runId: string, name: string, payload: unknown): Promise<void>;
  cancelRun(runId: string, reason: string): Promise<void>;
  /** Sends the update `name` and resolves with the api's answer. */
  updateRun(runId: string, name: string, argument: unknown): Promise<UpdateAnswer>;
  /** Answers the query `name` from the run's current state. */
  queryRun(runId: string, name: string, argument: unknown): Promise<unknown>;
  listDeadLetters(): Promise<readonly DeadLetter[]>;
  pause(subject: PauseSubject, reason: string): Promise<void>;
  resume(subject: PauseSubject): Promise<void>;
  listPauses(): Promise<readonly Pause[]>;
  listSchedules(): Promise<readonly Schedule[]>;
  pauseSchedule(scheduleId: string): Promise<void>;
  resumeSchedule(scheduleId: string): Promise<void>;
  /** Handles every trigger of `[from, to)` once and resolves with those this call handled. */
  backfillSchedule(
    scheduleId: string,
    from: string,
    to: string,
  ): Promise<readonly ScheduleTrigger[]>;
  requeueDeadLetter(id: string): Promise<void>;
  listQuarantined(): Promise<readonly QuarantinedTask[]>;
  /** Puts a quarantined task back on its queue with a fresh reclaim budget. */
  releaseQuarantined(taskId: string): Promise<void>;
  /**
   * Follows a run's history until the run closes or `signal` aborts. Resolves
   * with the last sequence number received, so a caller can resume from it.
   */
  streamRun(
    runId: string,
    after: number,
    onSlice: (slice: StreamSlice) => void,
    signal: AbortSignal,
  ): Promise<{ readonly lastSequence: number; readonly ended: boolean }>;
}

const MAX_DEAD_LETTER_PAGES = 10;

async function failure(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      response.status,
      body.error?.code ?? "error",
      body.error?.message ?? response.statusText,
    );
  } catch {
    return new ApiError(response.status, "error", response.statusText);
  }
}

/**
 * Creates the client over `fetchFn` (the browser's `fetch` in the app, a stub
 * in tests). `baseUrl` is the origin of the api, empty for the same origin.
 */
export function createApiClient(apiKey: string, fetchFn: typeof fetch, baseUrl = ""): ApiClient {
  const authorization = { authorization: `Bearer ${apiKey}` };

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers:
        body === undefined
          ? authorization
          : { ...authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw await failure(response);
    }
    return (await response.json()) as T;
  }

  return {
    namespace: () => request("GET", "/v1/namespace"),
    listRuns: (filters, limit, cursor) =>
      request("GET", `/v1/runs?${buildListQuery(filters, limit, cursor).toString()}`),
    describeRun: (runId) => request("GET", `/v1/runs/${encodeURIComponent(runId)}`),
    async decodePayloads(payloads) {
      const answer = await request<{ payloads: unknown[] }>("POST", "/v1/codec/decode", {
        payloads,
      });
      return answer.payloads;
    },
    async signalRun(runId, name, payload) {
      await request("POST", `/v1/runs/${encodeURIComponent(runId)}/signal`, {
        name,
        ...(payload === undefined ? {} : { payload }),
      });
    },
    updateRun: (runId, name, argument) =>
      request(
        "POST",
        `/v1/runs/${encodeURIComponent(runId)}/updates/${encodeURIComponent(name)}`,
        argument === undefined ? {} : { argument },
      ),
    async queryRun(runId, name, argument) {
      const search =
        argument === undefined ? "" : `?argument=${encodeURIComponent(JSON.stringify(argument))}`;
      const answer = await request<{ result: unknown }>(
        "GET",
        `/v1/runs/${encodeURIComponent(runId)}/queries/${encodeURIComponent(name)}${search}`,
      );
      return answer.result;
    },
    async cancelRun(runId, reason) {
      await request("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        ...(reason === "" ? {} : { reason }),
      });
    },
    async listDeadLetters() {
      const letters: DeadLetter[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_DEAD_LETTER_PAGES; page += 1) {
        const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
        const body = await request<{ deadLetters: DeadLetter[]; nextCursor?: string }>(
          "GET",
          `/v1/dead-letters${query}`,
        );
        letters.push(...body.deadLetters);
        cursor = body.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
      return letters;
    },
    async pause(subject, reason) {
      await request("POST", "/v1/pauses", { ...subject, ...(reason === "" ? {} : { reason }) });
    },
    async resume(subject) {
      await request("POST", "/v1/pauses/resume", subject);
    },
    async listPauses() {
      return (await request<{ pauses: Pause[] }>("GET", "/v1/pauses")).pauses;
    },
    async listSchedules() {
      return (await request<{ schedules: Schedule[] }>("GET", "/v1/schedules")).schedules;
    },
    async pauseSchedule(scheduleId) {
      await request("POST", `/v1/schedules/${encodeURIComponent(scheduleId)}/pause`, {});
    },
    async resumeSchedule(scheduleId) {
      await request("POST", `/v1/schedules/${encodeURIComponent(scheduleId)}/resume`, {});
    },
    async backfillSchedule(scheduleId, from, to) {
      const answer = await request<{ triggers: ScheduleTrigger[] }>(
        "POST",
        `/v1/schedules/${encodeURIComponent(scheduleId)}/backfill`,
        { from, to },
      );
      return answer.triggers;
    },
    async requeueDeadLetter(id) {
      await request("POST", `/v1/dead-letters/${encodeURIComponent(id)}/requeue`, {});
    },
    async listQuarantined() {
      return (await request<{ tasks: QuarantinedTask[] }>("GET", "/v1/quarantined-tasks")).tasks;
    },
    async releaseQuarantined(taskId) {
      await request("POST", `/v1/quarantined-tasks/${encodeURIComponent(taskId)}/release`, {});
    },
    async streamRun(runId, after, onSlice, signal) {
      const response = await fetchFn(
        `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/stream?after=${String(after)}`,
        { headers: { ...authorization, accept: "text/event-stream" }, signal },
      );
      if (!response.ok || response.body === null) {
        throw await failure(response);
      }
      let lastSequence = after;
      let ended = false;
      const parser = createSseParser((message) => {
        if (message.event === "end") {
          ended = true;
          return;
        }
        if (message.event === "slice") {
          const slice = JSON.parse(message.data) as StreamSlice;
          const last = slice.events.at(-1);
          if (last !== undefined) {
            lastSequence = last.sequenceNumber;
          }
          onSlice(slice);
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          parser(decoder.decode(chunk.value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
      return { lastSequence, ended };
    },
  };
}
