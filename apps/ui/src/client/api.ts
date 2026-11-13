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
}

/**
 * A run with its input, result and error.
 */
export interface RunDescription extends RunSummary {
  readonly input: unknown;
  readonly result: unknown;
  readonly error: { readonly name: string; readonly message: string } | null;
  readonly lastSequenceNumber: number;
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
  signalRun(runId: string, name: string, payload: unknown): Promise<void>;
  cancelRun(runId: string, reason: string): Promise<void>;
  /** Sends the update `name` and resolves with the api's answer. */
  updateRun(runId: string, name: string, argument: unknown): Promise<UpdateAnswer>;
  /** Answers the query `name` from the run's current state. */
  queryRun(runId: string, name: string, argument: unknown): Promise<unknown>;
  listDeadLetters(): Promise<readonly DeadLetter[]>;
  requeueDeadLetter(id: string): Promise<void>;
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
    async requeueDeadLetter(id) {
      await request("POST", `/v1/dead-letters/${encodeURIComponent(id)}/requeue`, {});
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
