import { ApiError } from "./errors.ts";

/**
 * A run as the api reports it.
 */
export interface RunSnapshot {
  readonly runId: string;
  readonly workflowType: string;
  readonly status: string;
  readonly startedAt: string;
  readonly closedAt: string | null;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string } | null;
}

/**
 * One page of `RunClient.listRuns`.
 */
export interface RunListPage {
  readonly runs: readonly RunSnapshot[];
  readonly nextCursor?: string;
}

/**
 * Filters of `RunClient.listRuns`.
 */
export interface ListFilter {
  readonly status?: string;
  readonly workflowType?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * One event of a run's history.
 */
export interface HistoryItem {
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly event: { readonly type: string } & Readonly<Record<string, unknown>>;
}

/**
 * Options of `RunClient.waitForClose`. `timeoutMs` defaults to 60000 and
 * `pollMs` to 50.
 */
export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

/**
 * The largest page `RunClient.listRuns` can ask the api for.
 */
export const MAX_LIST_LIMIT = 200;

/**
 * What a program needs to drive runs of a namespace: the surface the cli
 * commands and the example demos share.
 */
export interface RunClient {
  /** Starts a run and resolves with its id. A repeated `idempotencyKey` returns the first run. */
  start(workflowType: string, input?: unknown, idempotencyKey?: string): Promise<string>;
  signal(runId: string, name: string, payload?: unknown): Promise<void>;
  cancel(runId: string, reason?: string): Promise<void>;
  describe(runId: string): Promise<RunSnapshot>;
  history(runId: string): Promise<readonly HistoryItem[]>;
  listRuns(filter?: ListFilter): Promise<RunListPage>;
  /**
   * Resolves with the run once it is no longer `RUNNING`; rejects after
   * `timeoutMs`. An answer of 429 is waited out for the `Retry-After` the api
   * gave (at most until the timeout) instead of failing the wait.
   */
  waitForClose(runId: string, options?: WaitOptions): Promise<RunSnapshot>;
}

/**
 * Options for `createApiClient`. `fetch` defaults to the global one. `now`
 * and `sleep` default to the system clock and are replaced in tests.
 */
export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

const BODY_PREVIEW_CHARS = 120;
const DEFAULT_RETRY_AFTER_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return undefined;
  }
  if (/^\d+$/.test(header.trim())) {
    return Number(header) * 1000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function preview(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > BODY_PREVIEW_CHARS ? `${flat.slice(0, BODY_PREVIEW_CHARS)}...` : flat;
}

/**
 * Creates a `RunClient` that talks to the http api at `baseUrl` with a
 * bearer key. Error answers become `ApiError`s carrying the status and the
 * api's error code.
 */
export function createApiClient(options: ApiClientOptions): RunClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers = {},
  ): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      const detail = text === "" ? "" : `: ${preview(text)}`;
      throw new ApiError(
        response.status,
        "invalid_response",
        response.ok
          ? `the api answered ${String(response.status)} with a body that is not json${detail}`
          : `the api answered ${String(response.status)} without a json error body${detail}`,
        retryAfterMs(response, now()),
      );
    }
    if (!response.ok) {
      const failure = (parsed ?? {}) as ErrorBody;
      throw new ApiError(
        response.status,
        failure.error?.code ?? "unknown",
        failure.error?.message ?? `the api answered ${String(response.status)}`,
        retryAfterMs(response, now()),
      );
    }
    return parsed;
  }

  async function describe(runId: string): Promise<RunSnapshot> {
    return (await call("GET", `/v1/runs/${encodeURIComponent(runId)}`)) as RunSnapshot;
  }

  return {
    async start(workflowType, input, idempotencyKey) {
      const answer = (await call(
        "POST",
        "/v1/runs",
        { workflowType, ...(input === undefined ? {} : { input }) },
        idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
      )) as { run: RunSnapshot };
      return answer.run.runId;
    },
    async signal(runId, name, payload) {
      await call("POST", `/v1/runs/${encodeURIComponent(runId)}/signal`, {
        name,
        ...(payload === undefined ? {} : { payload }),
      });
    },
    async cancel(runId, reason) {
      await call(
        "POST",
        `/v1/runs/${encodeURIComponent(runId)}/cancel`,
        reason === undefined ? {} : { reason },
      );
    },
    describe,
    async history(runId) {
      const events: HistoryItem[] = [];
      let cursor: string | undefined;
      do {
        const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
        const answer = (await call(
          "GET",
          `/v1/runs/${encodeURIComponent(runId)}/history${query}`,
        )) as { events: HistoryItem[]; nextCursor?: string };
        events.push(...answer.events);
        cursor = answer.nextCursor;
      } while (cursor !== undefined);
      return events;
    },
    async listRuns(filter = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined) {
          query.set(key, String(value));
        }
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return (await call("GET", `/v1/runs${suffix}`)) as RunListPage;
    },
    async waitForClose(runId, waitOptions = {}) {
      const deadline = now() + (waitOptions.timeoutMs ?? 60_000);
      const pollMs = waitOptions.pollMs ?? 50;
      let lastStatus = "RUNNING";
      for (;;) {
        let waitMs = pollMs;
        try {
          const run = await describe(runId);
          if (run.status !== "RUNNING") {
            return run;
          }
          lastStatus = run.status;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 429) {
            throw error;
          }
          waitMs = Math.max(pollMs, error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
        }
        const remaining = deadline - now();
        if (remaining <= 0) {
          throw new Error(`run ${runId} was still ${lastStatus} after the wait timeout`);
        }
        await sleep(Math.min(waitMs, remaining));
      }
    },
  };
}
