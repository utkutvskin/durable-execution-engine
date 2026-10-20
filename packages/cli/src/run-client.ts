import { ApiError } from "./errors.js";

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
  /** Resolves with the run once it is no longer `RUNNING`; rejects after `timeoutMs`. */
  waitForClose(runId: string, options?: WaitOptions): Promise<RunSnapshot>;
}

/**
 * Options for `createApiClient`. `fetch` defaults to the global one.
 */
export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Creates a `RunClient` that talks to the http api at `baseUrl` with a
 * bearer key. Error answers become `ApiError`s carrying the status and the
 * api's error code.
 */
export function createApiClient(options: ApiClientOptions): RunClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

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
    const parsed: unknown = text === "" ? undefined : JSON.parse(text);
    if (!response.ok) {
      const failure = (parsed ?? {}) as ErrorBody;
      throw new ApiError(
        response.status,
        failure.error?.code ?? "unknown",
        failure.error?.message ?? `the api answered ${String(response.status)}`,
      );
    }
    return parsed;
  }

  async function describe(runId: string): Promise<RunSnapshot> {
    return (await call("GET", `/v1/runs/${runId}`)) as RunSnapshot;
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
      await call("POST", `/v1/runs/${runId}/signal`, {
        name,
        ...(payload === undefined ? {} : { payload }),
      });
    },
    async cancel(runId, reason) {
      await call("POST", `/v1/runs/${runId}/cancel`, reason === undefined ? {} : { reason });
    },
    describe,
    async history(runId) {
      const answer = (await call("GET", `/v1/runs/${runId}/history`)) as {
        events: HistoryItem[];
      };
      return answer.events;
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
      const deadline = Date.now() + (waitOptions.timeoutMs ?? 60_000);
      const pollMs = waitOptions.pollMs ?? 50;
      for (;;) {
        const run = await describe(runId);
        if (run.status !== "RUNNING") {
          return run;
        }
        if (Date.now() >= deadline) {
          throw new Error(`run ${runId} was still ${run.status} after the wait timeout`);
        }
        await delay(pollMs);
      }
    },
  };
}
