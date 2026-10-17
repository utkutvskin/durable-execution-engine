import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Pool } from "@dee/core";
import { createApiKeyStore, type ApiKeyStore, type AuthenticatedNamespace } from "./api-keys.js";
import { buildOpenApiDocument, type JsonObject } from "./openapi.js";
import {
  METRICS_CONTENT_TYPE,
  createEngineMetrics,
  createHealthChecks,
  createLogger,
  resolveCorrelationId,
  withCorrelationId,
  type EngineMetrics,
  type HealthChecks,
  type Logger,
  type Tracing,
} from "@dee/core";
import { createQuotaGuard, type QuotaGuard, type RequestKind } from "./quota-guard.js";
import { createRoutes, toErrorResult, type RawRequest, type Route } from "./routes.js";
import { createRunService, type RunService } from "./run-service.js";

/**
 * Serves requests the api does not own, such as the web ui's static files.
 * Returns true when it answered the request.
 */
export type SideHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

/**
 * Options for `createApiHandler`. `queueName` is the queue the workflow
 * tasks of started, signalled and cancelled runs go to. With `tracing`, a
 * started run gets a `workflow.start` span that continues the request's
 * `traceparent` header and that the run's later spans hang under.
 *
 * `GET /health`, `GET /ready` and `GET /metrics` are public. `health` and
 * `metrics` default to the ones built over the pool. Every request gets a
 * correlation id (the `x-correlation-id` request header when usable, else a
 * new uuid), returned in the same response header and attached to the
 * request's log lines written through `logger`.
 *
 * `GET /v1/runs/{runId}/stream` is a server sent events stream of a run's
 * history, polled from the database every `streamPollMs` (default 500). It
 * is not part of the OpenAPI document. The handler reads its clocks and
 * timers from `node:perf_hooks` and `node:timers`, which workflow decisions
 * do not patch, so it keeps working in a process that also decides workflows. `sideHandler` is offered every request
 * first and answers the ones that are not api calls.
 */
export interface ApiOptions {
  readonly queueName: string;
  readonly maxBodyBytes?: number;
  readonly apiKeys?: ApiKeyStore;
  readonly service?: RunService;
  readonly quotaGuard?: QuotaGuard;
  readonly maxQueueDepth?: number;
  readonly tracing?: Tracing;
  readonly health?: HealthChecks;
  readonly metrics?: EngineMetrics;
  readonly logger?: Logger;
  readonly streamPollMs?: number;
  readonly sideHandler?: SideHandler;
}

/**
 * The request handler plus the pieces it was built from.
 */
export interface ApiHandler {
  readonly listener: (request: IncomingMessage, response: ServerResponse) => void;
  readonly apiKeys: ApiKeyStore;
  readonly routes: readonly Route[];
  readonly openApiDocument: JsonObject;
  readonly metrics: EngineMetrics;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_STREAM_POLL_MS = 500;
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_PATH = "/v1/runs/{runId}/stream";

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`the request body exceeds ${String(limit)} bytes`);
    this.name = "BodyTooLargeError";
  }
}

class BodyNotJsonError extends Error {
  constructor() {
    super("the request body is not valid JSON");
    this.name = "BodyNotJsonError";
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) {
      throw new BodyTooLargeError(limit);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BodyNotJsonError();
  }
}

function matchPath(template: string, path: string): Record<string, string> | undefined {
  const templateParts = template.split("/");
  const pathParts = path.split("/");
  if (templateParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, part] of templateParts.entries()) {
    const actual = pathParts[index] ?? "";
    const parameter = /^\{(\w+)\}$/.exec(part);
    if (parameter?.[1] !== undefined) {
      params[parameter[1]] = decodeURIComponent(actual);
    } else if (part !== actual) {
      return undefined;
    }
  }
  return params;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function sleepUnlessClosed(response: ServerResponse, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      response.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    response.once("close", finish);
  });
}

function isClosed(response: ServerResponse): boolean {
  return response.destroyed || response.writableEnded;
}

function parseStreamCursor(url: URL, request: IncomingMessage): number {
  const raw = url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
  const value = Array.isArray(raw) ? (raw[0] ?? "0") : raw;
  if (!/^\d{1,15}$/.test(value)) {
    throw new z.ZodError([
      { code: "custom", path: ["after"], message: "must be a non negative integer" },
    ]);
  }
  return Number(value);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } });
}

/**
 * Builds the request handler for the api over `pool`. Public endpoints:
 * `GET /openapi.json`. Everything under `/v1` needs a bearer api key and is
 * scoped to that key's namespace.
 */
export function createApiHandler(pool: Pool, options: ApiOptions): ApiHandler {
  const apiKeys = options.apiKeys ?? createApiKeyStore(pool);
  const service =
    options.service ??
    createRunService(pool, {
      queueName: options.queueName,
      ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
    });
  const routes = createRoutes(service);
  const openApiDocument = buildOpenApiDocument(routes);
  const quotaGuard =
    options.quotaGuard ??
    createQuotaGuard(pool, {
      queueName: options.queueName,
      ...(options.maxQueueDepth === undefined ? {} : { maxQueueDepth: options.maxQueueDepth }),
    });
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const health = options.health ?? createHealthChecks(pool);
  const metrics = options.metrics ?? createEngineMetrics(pool);
  const logger = options.logger ?? createLogger();
  const streamPollMs = options.streamPollMs ?? DEFAULT_STREAM_POLL_MS;

  async function handleOperational(pathname: string, response: ServerResponse): Promise<boolean> {
    if (pathname === "/health") {
      send(response, 200, health.live());
      return true;
    }
    if (pathname === "/ready") {
      const readiness = await health.ready();
      send(response, readiness.ready ? 200 : 503, {
        status: readiness.ready ? "ok" : "unavailable",
        checks: readiness.checks,
      });
      return true;
    }
    if (pathname === "/metrics") {
      let text: string;
      try {
        text = await metrics.render();
      } catch (error) {
        logger.error("metrics render failed", { error });
        sendError(response, 503, "metrics_unavailable", "metrics could not be collected");
        return true;
      }
      response.writeHead(200, {
        "content-type": METRICS_CONTENT_TYPE,
        "content-length": Buffer.byteLength(text),
      });
      response.end(text);
      return true;
    }
    return false;
  }

  async function streamRun(
    request: IncomingMessage,
    response: ServerResponse,
    identity: AuthenticatedNamespace,
    runId: string,
    url: URL,
  ): Promise<void> {
    const rejection = await quotaGuard.check(identity.namespaceId, "read");
    if (rejection !== undefined) {
      send(
        response,
        rejection.status,
        { error: { code: rejection.code, message: rejection.message } },
        { "retry-after": String(rejection.retryAfterSeconds) },
      );
      return;
    }
    let cursor = parseStreamCursor(url, request);
    let slice = await service.readHistorySince(identity.namespaceId, runId, cursor);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": open\n\n");
    let lastStatus: string | undefined;
    let idlePolls = 0;
    const heartbeatEvery = Math.max(1, Math.round(STREAM_HEARTBEAT_MS / streamPollMs));
    while (!isClosed(response)) {
      const last = slice.events.at(-1);
      if (slice.events.length > 0 || slice.status !== lastStatus) {
        if (last !== undefined) {
          cursor = last.sequenceNumber;
        }
        lastStatus = slice.status;
        idlePolls = 0;
        response.write(
          `id: ${String(cursor)}\nevent: slice\ndata: ${JSON.stringify({
            events: slice.events,
            status: slice.status,
            closed: slice.closed,
          })}\n\n`,
        );
      } else if (slice.closed) {
        response.write("event: end\ndata: {}\n\n");
        response.end();
        return;
      } else {
        idlePolls += 1;
        if (idlePolls % heartbeatEvery === 0) {
          response.write(": ping\n\n");
        }
      }
      await sleepUnlessClosed(response, streamPollMs);
      if (isClosed(response)) {
        return;
      }
      slice = await service.readHistorySince(identity.namespaceId, runId, cursor);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = (request.method ?? "GET").toLowerCase();

    if (options.sideHandler?.(request, response) === true) {
      return;
    }

    if (method === "get" && (await handleOperational(url.pathname, response))) {
      return;
    }

    if (url.pathname === "/openapi.json" && method === "get") {
      send(response, 200, openApiDocument);
      return;
    }

    const streamParams = method === "get" ? matchPath(STREAM_PATH, url.pathname) : undefined;
    if (streamParams !== undefined) {
      const streamToken = bearerToken(request);
      const streamIdentity =
        streamToken === undefined ? undefined : await apiKeys.authenticate(streamToken);
      if (streamIdentity === undefined) {
        send(
          response,
          401,
          { error: { code: "unauthorized", message: "a valid bearer api key is required" } },
          { "www-authenticate": 'Bearer realm="dee"' },
        );
        return;
      }
      await streamRun(request, response, streamIdentity, streamParams["runId"] ?? "", url);
      return;
    }

    const candidates = routes
      .map((route) => ({ route, params: matchPath(route.path, url.pathname) }))
      .filter((candidate) => candidate.params !== undefined);
    if (candidates.length === 0) {
      sendError(response, 404, "not_found", "no such endpoint");
      return;
    }

    const token = bearerToken(request);
    const identity = token === undefined ? undefined : await apiKeys.authenticate(token);
    if (identity === undefined) {
      send(
        response,
        401,
        { error: { code: "unauthorized", message: "a valid bearer api key is required" } },
        { "www-authenticate": 'Bearer realm="dee"' },
      );
      return;
    }

    const match = candidates.find((candidate) => candidate.route.method === method);
    if (match?.params === undefined) {
      send(
        response,
        405,
        { error: { code: "method_not_allowed", message: "method not allowed" } },
        { allow: candidates.map((candidate) => candidate.route.method.toUpperCase()).join(", ") },
      );
      return;
    }

    const kind: RequestKind =
      method === "get" ? "read" : match.route.operationId === "startRun" ? "start" : "write";
    const rejection = await quotaGuard.check(identity.namespaceId, kind);
    if (rejection !== undefined) {
      send(
        response,
        rejection.status,
        { error: { code: rejection.code, message: rejection.message } },
        { "retry-after": String(rejection.retryAfterSeconds) },
      );
      return;
    }

    const rawRequest: RawRequest = {
      namespaceId: identity.namespaceId,
      params: match.params,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value[0] : value,
        ]),
      ),
      body: method === "post" ? await readBody(request, maxBodyBytes) : undefined,
    };
    const result = await match.route.execute(rawRequest);
    send(response, result.status, result.body);
  }

  return {
    apiKeys,
    routes,
    openApiDocument,
    metrics,
    listener(request, response): void {
      const correlationId = resolveCorrelationId(
        Array.isArray(request.headers["x-correlation-id"])
          ? request.headers["x-correlation-id"][0]
          : request.headers["x-correlation-id"],
      );
      response.setHeader("x-correlation-id", correlationId);
      const startedAt = performance.now();
      response.on("finish", () => {
        withCorrelationId(correlationId, () => {
          logger.info("request completed", {
            method: request.method,
            path: (request.url ?? "/").split("?")[0],
            status: response.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          });
        });
      });
      withCorrelationId(correlationId, () => handle(request, response)).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (error instanceof BodyTooLargeError) {
          sendError(response, 413, "payload_too_large", error.message);
        } else if (error instanceof BodyNotJsonError) {
          sendError(response, 400, "invalid_json", error.message);
        } else {
          const mapped = toErrorResult(error);
          send(response, mapped.status, mapped.body);
        }
      });
    },
  };
}

/**
 * Creates an http server around `createApiHandler`. The caller listens.
 */
export function createApiServer(pool: Pool, options: ApiOptions): { server: Server } & ApiHandler {
  const handler = createApiHandler(pool, options);
  return { ...handler, server: createServer(handler.listener) };
}
