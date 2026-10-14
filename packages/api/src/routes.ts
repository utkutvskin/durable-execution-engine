import { z } from "zod";
import { RunAlreadyClosedError, RunNotFoundError, RunNotOpenError } from "@dee/core";
import { IdempotencyConflictError, InvalidCursorError, type RunService } from "./run-service.js";

/**
 * What a route handler produces: a status code and a JSON body.
 */
export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A request after authentication, before schema validation.
 */
export interface RawRequest {
  readonly namespaceId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

/**
 * One response an operation can produce, as the OpenAPI document lists it.
 */
export interface ResponseSpec {
  readonly description: string;
  readonly schema?: z.ZodType;
}

/**
 * An endpoint: its OpenAPI description and its handler in one place, so the
 * generated document cannot drift from what the server does.
 */
export interface Route {
  readonly method: "get" | "post";
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly body?: z.ZodType;
  readonly query?: z.ZodObject;
  readonly headerParameters: readonly { name: string; description: string }[];
  readonly responses: Readonly<Record<number, ResponseSpec>>;
  execute(request: RawRequest): Promise<RouteResult>;
}

/**
 * The body of every error response.
 */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ description: "A stable machine readable error code." }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "ErrorResponse" });

const runStatusSchema = z.enum([
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
  "CONTINUED_AS_NEW",
]);

const runSummarySchema = z
  .object({
    runId: z.uuid(),
    workflowType: z.string(),
    status: runStatusSchema,
    startedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "RunSummary" });

const runDescriptionSchema = runSummarySchema
  .extend({
    input: z.unknown(),
    result: z.unknown(),
    error: z.object({ name: z.string(), message: z.string() }).nullable(),
    lastSequenceNumber: z.number().int(),
    idempotencyKey: z.string().nullable(),
  })
  .meta({ id: "RunDescription" });

const startRequestSchema = z
  .object({
    workflowType: z.string().min(1).max(255),
    input: z.unknown().optional(),
  })
  .meta({ id: "StartRunRequest" });

const startResponseSchema = z
  .object({ created: z.boolean(), run: runDescriptionSchema })
  .meta({ id: "StartRunResponse" });

const listQuerySchema = z.object({
  status: runStatusSchema.optional(),
  workflowType: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

const listResponseSchema = z
  .object({ runs: z.array(runSummarySchema), nextCursor: z.string().optional() })
  .meta({ id: "RunListResponse" });

const historyResponseSchema = z
  .object({
    events: z.array(
      z.object({
        sequenceNumber: z.number().int(),
        createdAt: z.iso.datetime(),
        event: z.looseObject({ type: z.string() }),
      }),
    ),
  })
  .meta({ id: "HistoryResponse" });

const signalRequestSchema = z
  .object({ name: z.string().min(1).max(255), payload: z.unknown().optional() })
  .meta({ id: "SignalRequest" });

const reasonRequestSchema = z
  .object({ reason: z.string().max(1000).optional() })
  .meta({ id: "ReasonRequest" });

const sequenceResponseSchema = z
  .object({ sequenceNumber: z.number().int() })
  .meta({ id: "SequenceResponse" });

const cancelResponseSchema = z
  .object({ requested: z.boolean(), sequenceNumber: z.number().int() })
  .meta({ id: "CancelResponse" });

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const errorResponse = (description: string): ResponseSpec => ({
  description,
  schema: errorResponseSchema,
});

const commonErrors = {
  400: errorResponse("The request is malformed."),
  401: errorResponse("The api key is missing, unknown or revoked."),
  429: errorResponse(
    "The namespace exceeded its rate limit or a quota. The Retry-After header gives the wait in seconds.",
  ),
  503: errorResponse(
    "The task queue is overloaded and admits no new work. The Retry-After header gives the wait in seconds.",
  ),
} as const;

const notFound = errorResponse("The run does not exist in the caller's namespace.");

interface RouteDefinition<TBody, TQuery> {
  readonly method: "get" | "post";
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly body?: z.ZodType<TBody>;
  readonly query?: z.ZodObject & z.ZodType<TQuery>;
  readonly headerParameters?: readonly { name: string; description: string }[];
  readonly responses: Readonly<Record<number, ResponseSpec>>;
  readonly handle: (
    request: RawRequest & { readonly parsedBody: TBody; readonly parsedQuery: TQuery },
  ) => Promise<RouteResult>;
}

function defineRoute<TBody = undefined, TQuery = undefined>(
  definition: RouteDefinition<TBody, TQuery>,
): Route {
  const { handle, body, query, headerParameters, ...description } = definition;
  return {
    ...description,
    ...(body === undefined ? {} : { body }),
    ...(query === undefined ? {} : { query }),
    headerParameters: headerParameters ?? [],
    async execute(request: RawRequest): Promise<RouteResult> {
      const parsedBody = (body === undefined ? undefined : body.parse(request.body)) as TBody;
      const parsedQuery = (query === undefined ? undefined : query.parse(request.query)) as TQuery;
      return handle({ ...request, parsedBody, parsedQuery });
    },
  };
}

function runIdOf(request: RawRequest): string {
  return request.params["runId"] ?? "";
}

/**
 * Builds the route table over `service`. Every handler reads the caller's
 * namespace from the authenticated request and passes it down; none reads a
 * namespace from the request body or query.
 */
export function createRoutes(service: RunService): readonly Route[] {
  return [
    defineRoute({
      method: "post",
      path: "/v1/runs",
      operationId: "startRun",
      summary: "Start a workflow run. Repeating an Idempotency-Key returns the same run.",
      body: startRequestSchema,
      headerParameters: [
        {
          name: "Idempotency-Key",
          description: "Optional. Two starts with the same key in one namespace create one run.",
        },
      ],
      responses: {
        200: {
          description: "The idempotency key had started this run already.",
          schema: startResponseSchema,
        },
        201: { description: "The run was created.", schema: startResponseSchema },
        ...commonErrors,
        409: errorResponse("The idempotency key was used for a different request."),
      },
      async handle(request) {
        const key = request.headers["idempotency-key"];
        if (key !== undefined && (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
          throw new z.ZodError([
            {
              code: "custom",
              path: ["Idempotency-Key"],
              message: `must be 1 to ${String(MAX_IDEMPOTENCY_KEY_LENGTH)} characters`,
            },
          ]);
        }
        const result = await service.startRun(request.namespaceId, {
          workflowType: request.parsedBody.workflowType,
          input: request.parsedBody.input,
          ...(key === undefined ? {} : { idempotencyKey: key }),
        });
        return { status: result.created ? 201 : 200, body: result };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/runs",
      operationId: "listRuns",
      summary: "List the namespace's runs, newest first.",
      query: listQuerySchema,
      responses: {
        200: { description: "One page of runs.", schema: listResponseSchema },
        ...commonErrors,
      },
      async handle(request) {
        const page = await service.listRuns(request.namespaceId, request.parsedQuery);
        return { status: 200, body: page };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/runs/{runId}",
      operationId: "describeRun",
      summary: "Describe one run.",
      responses: {
        200: { description: "The run.", schema: runDescriptionSchema },
        ...commonErrors,
        404: notFound,
      },
      async handle(request) {
        return {
          status: 200,
          body: await service.describeRun(request.namespaceId, runIdOf(request)),
        };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/runs/{runId}/history",
      operationId: "getHistory",
      summary: "Read the run's event history.",
      responses: {
        200: { description: "The events in sequence order.", schema: historyResponseSchema },
        ...commonErrors,
        404: notFound,
      },
      async handle(request) {
        const events = await service.getHistory(request.namespaceId, runIdOf(request));
        return { status: 200, body: { events } };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/runs/{runId}/signal",
      operationId: "signalRun",
      summary: "Send a signal to an open run.",
      body: signalRequestSchema,
      responses: {
        200: { description: "The signal was recorded.", schema: sequenceResponseSchema },
        ...commonErrors,
        404: notFound,
        409: errorResponse("The run is closed."),
      },
      async handle(request) {
        const receipt = await service.signalRun(
          request.namespaceId,
          runIdOf(request),
          request.parsedBody.name,
          request.parsedBody.payload,
        );
        return { status: 200, body: receipt };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/runs/{runId}/cancel",
      operationId: "cancelRun",
      summary: "Request graceful cancellation of an open run.",
      body: reasonRequestSchema,
      responses: {
        202: { description: "The cancellation was requested.", schema: cancelResponseSchema },
        ...commonErrors,
        404: notFound,
        409: errorResponse("The run is closed."),
      },
      async handle(request) {
        const receipt = await service.cancelRun(
          request.namespaceId,
          runIdOf(request),
          request.parsedBody.reason,
        );
        return { status: 202, body: receipt };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/runs/{runId}/terminate",
      operationId: "terminateRun",
      summary: "Close an open run immediately, without compensation.",
      body: reasonRequestSchema,
      responses: {
        200: { description: "The run was terminated.", schema: sequenceResponseSchema },
        ...commonErrors,
        404: notFound,
        409: errorResponse("The run is closed."),
      },
      async handle(request) {
        const receipt = await service.terminateRun(
          request.namespaceId,
          runIdOf(request),
          request.parsedBody.reason,
        );
        return { status: 200, body: receipt };
      },
    }),
  ];
}

/**
 * An error response ready to be written.
 */
export interface ErrorResult extends RouteResult {
  readonly body: { readonly error: { code: string; message: string; details?: unknown } };
}

/**
 * Maps an error thrown by a route to its HTTP response. Anything that is
 * not a known client error becomes an opaque 500.
 */
export function toErrorResult(error: unknown): ErrorResult {
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "validation_failed",
          message: "the request does not match the schema",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    };
  }
  if (error instanceof RunNotFoundError) {
    return { status: 404, body: { error: { code: "not_found", message: "run not found" } } };
  }
  if (error instanceof RunNotOpenError || error instanceof RunAlreadyClosedError) {
    return { status: 409, body: { error: { code: "run_closed", message: error.message } } };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: { error: { code: "idempotency_conflict", message: error.message } },
    };
  }
  if (error instanceof InvalidCursorError) {
    return { status: 400, body: { error: { code: "invalid_cursor", message: error.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "internal", message: "the server could not process the request" } },
  };
}
