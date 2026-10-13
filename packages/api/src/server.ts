import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Pool } from "@dee/core";
import { createApiKeyStore, type ApiKeyStore } from "./api-keys.js";
import { buildOpenApiDocument, type JsonObject } from "./openapi.js";
import { createRoutes, toErrorResult, type RawRequest, type Route } from "./routes.js";
import { createRunService, type RunService } from "./run-service.js";

/**
 * Options for `createApiHandler`. `queueName` is the queue the workflow
 * tasks of started, signalled and cancelled runs go to.
 */
export interface ApiOptions {
  readonly queueName: string;
  readonly maxBodyBytes?: number;
  readonly apiKeys?: ApiKeyStore;
  readonly service?: RunService;
}

/**
 * The request handler plus the pieces it was built from.
 */
export interface ApiHandler {
  readonly listener: (request: IncomingMessage, response: ServerResponse) => void;
  readonly apiKeys: ApiKeyStore;
  readonly routes: readonly Route[];
  readonly openApiDocument: JsonObject;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

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
  const service = options.service ?? createRunService(pool, { queueName: options.queueName });
  const routes = createRoutes(service);
  const openApiDocument = buildOpenApiDocument(routes);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = (request.method ?? "GET").toLowerCase();

    if (url.pathname === "/openapi.json" && method === "get") {
      send(response, 200, openApiDocument);
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
    listener(request, response): void {
      handle(request, response).catch((error: unknown) => {
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
