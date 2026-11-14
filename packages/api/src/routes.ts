import { z } from "zod";
import {
  MAX_EVENT_BUFFER_MS,
  MAX_UPDATE_WAIT_MS,
  RunAlreadyClosedError,
  RunHistoryCompactedError,
  RunNotFoundError,
  RunNotOpenError,
  UnknownQueryError,
  UnknownUpdateError,
  UpdateRejectedError,
  WorkflowKeyConflictError,
  WorkflowNotLoadedError,
} from "@dee/core";
import {
  DeadLetterNotFoundError,
  IdempotencyConflictError,
  InvalidCursorError,
  MAX_PAGE_LIMIT,
  UnknownWorkflowTypeError,
  type RunService,
} from "./run-service.ts";

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
    runTimeoutMs: z.number().positive().optional(),
    executionTimeoutMs: z.number().positive().optional(),
  })
  .meta({ id: "StartRunRequest" });

const startResponseSchema = z
  .object({ created: z.boolean(), run: runDescriptionSchema })
  .meta({ id: "StartRunResponse" });

const listQuerySchema = z.object({
  status: runStatusSchema.optional(),
  workflowType: z.string().min(1).optional(),
  startedAfter: z.iso.datetime().optional(),
  startedBefore: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

const listResponseSchema = z
  .object({ runs: z.array(runSummarySchema), nextCursor: z.string().optional() })
  .meta({ id: "RunListResponse" });

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
});

const historyResponseSchema = z
  .object({
    nextCursor: z.string().optional(),
    events: z.array(
      z.object({
        sequenceNumber: z.number().int(),
        createdAt: z.iso.datetime(),
        version: z.number().int().min(1),
        event: z.looseObject({ type: z.string() }),
      }),
    ),
  })
  .meta({ id: "HistoryResponse" });

const namespaceSchema = z
  .object({ id: z.uuid(), name: z.string() })
  .meta({ id: "NamespaceDescription" });

const deadLetterSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    stepId: z.string(),
    attempts: z.number().int(),
    error: z.object({ name: z.string(), message: z.string() }),
    reason: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "DeadLetter" });

const deadLetterListSchema = z
  .object({ deadLetters: z.array(deadLetterSchema), nextCursor: z.string().optional() })
  .meta({ id: "DeadLetterListResponse" });

const requeueResponseSchema = z.object({ taskId: z.uuid() }).meta({ id: "RequeueResponse" });

const signalIdSchema = z.string().min(1).max(255).optional().meta({
  description:
    "Optional. A deduplication id: a second signal with the same id in the run's continue-as-new chain is not recorded again.",
});

const signalRequestSchema = z
  .object({
    name: z.string().min(1).max(255),
    payload: z.unknown().optional(),
    signalId: signalIdSchema,
  })
  .meta({ id: "SignalRequest" });

const signalResponseSchema = z
  .object({
    runId: z.uuid().meta({
      description:
        "The run that received the signal: the current run of the chain when the addressed run continued as new.",
    }),
    sequenceNumber: z.number().int(),
    duplicate: z.boolean().meta({
      description: "True when the signal id was used before; nothing was recorded.",
    }),
  })
  .meta({ id: "SignalResponse" });

const signalWithStartRequestSchema = z
  .object({
    workflowType: z.string().min(1).max(255),
    workflowKey: z.string().min(1).max(255).meta({
      description:
        "The run's idempotency key. The run holding it is signalled; without one, a run is started first.",
    }),
    input: z.unknown().optional(),
    signal: z.object({
      name: z.string().min(1).max(255),
      payload: z.unknown().optional(),
      signalId: signalIdSchema,
    }),
  })
  .meta({ id: "SignalWithStartRequest" });

const signalWithStartResponseSchema = signalResponseSchema
  .extend({ created: z.boolean() })
  .meta({ id: "SignalWithStartResponse" });

const sendEventRequestSchema = z
  .object({
    name: z.string().min(1).max(255),
    key: z.string().max(1024).meta({ description: "The correlation key waits match on." }),
    payload: z.unknown().optional(),
    bufferMs: z.number().int().min(0).max(MAX_EVENT_BUFFER_MS).optional().meta({
      description:
        "How long the event stays deliverable to runs that wait for it later. Defaults to 3600000.",
    }),
  })
  .meta({ id: "SendEventRequest" });

const sendEventResponseSchema = z
  .object({
    eventId: z.uuid(),
    expiresAt: z.iso.datetime(),
    deliveredTo: z.array(z.object({ runId: z.uuid(), waitId: z.string() })),
    startedRunIds: z.array(z.uuid()),
  })
  .meta({ id: "SendEventResponse" });

const eventTriggerRequestSchema = z
  .object({
    eventName: z.string().min(1).max(255),
    key: z.string().max(1024).optional().meta({
      description: "Optional. Only events with exactly this correlation key start a run.",
    }),
    workflowType: z.string().min(1).max(255),
  })
  .meta({ id: "EventTriggerRequest" });

const eventTriggerSchema = z
  .object({
    id: z.uuid(),
    eventName: z.string(),
    key: z.string().optional(),
    workflowType: z.string(),
    queueName: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "EventTrigger" });

const eventTriggerListSchema = z
  .object({ triggers: z.array(eventTriggerSchema) })
  .meta({ id: "EventTriggerListResponse" });

function toTriggerBody(trigger: {
  readonly id: string;
  readonly eventName: string;
  readonly key: string | undefined;
  readonly workflowType: string;
  readonly queueName: string;
  readonly createdAt: Date;
}): z.infer<typeof eventTriggerSchema> {
  return {
    id: trigger.id,
    eventName: trigger.eventName,
    ...(trigger.key === undefined ? {} : { key: trigger.key }),
    workflowType: trigger.workflowType,
    queueName: trigger.queueName,
    createdAt: trigger.createdAt.toISOString(),
  };
}

const updateRequestSchema = z
  .object({
    argument: z.unknown().optional(),
    updateId: z.string().min(1).max(255).optional().meta({
      description: "Optional. A second call with the same id on the same run waits for the first.",
    }),
    waitMs: z.number().int().min(0).max(MAX_UPDATE_WAIT_MS).optional().meta({
      description: "How long to wait for the result. Defaults to 10000.",
    }),
  })
  .meta({ id: "UpdateRequest" });

const recordedErrorResponseSchema = z.looseObject({ name: z.string(), message: z.string() });

const updateResponseSchema = z
  .object({
    status: z.enum(["completed", "failed", "accepted"]),
    updateId: z.string(),
    sequenceNumber: z.number().int(),
    result: z.unknown().optional(),
    error: recordedErrorResponseSchema.optional(),
  })
  .meta({ id: "UpdateResponse" });

const queryParametersSchema = z.object({
  argument: z.string().max(65_536).optional().meta({
    description: "Optional. The query argument, encoded as JSON.",
  }),
});

const queryResponseSchema = z.object({ result: z.unknown() }).meta({ id: "QueryResponse" });

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
const deadLetterNotFound = errorResponse(
  "The dead letter does not exist in the caller's namespace or was requeued already.",
);

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

function deadLetterIdOf(request: RawRequest): string {
  return request.params["deadLetterId"] ?? "";
}

function runIdOf(request: RawRequest): string {
  return request.params["runId"] ?? "";
}

function parseQueryArgument(encoded: string | undefined): unknown {
  if (encoded === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new z.ZodError([
      { code: "custom", path: ["argument"], message: "must be a JSON encoded value" },
    ]);
  }
}

const replayErrors = {
  409: errorResponse("The run is closed, or its history was compacted."),
  501: errorResponse("The api process was started without the module of the run's workflow."),
} as const;

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
          ...(request.parsedBody.runTimeoutMs === undefined
            ? {}
            : { runTimeoutMs: request.parsedBody.runTimeoutMs }),
          ...(request.parsedBody.executionTimeoutMs === undefined
            ? {}
            : { executionTimeoutMs: request.parsedBody.executionTimeoutMs }),
          ...(key === undefined ? {} : { idempotencyKey: key }),
          ...(request.headers["traceparent"] === undefined
            ? {}
            : { traceparent: request.headers["traceparent"] }),
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
      path: "/v1/namespace",
      operationId: "describeNamespace",
      summary: "Describe the namespace the api key belongs to.",
      responses: {
        200: { description: "The namespace.", schema: namespaceSchema },
        ...commonErrors,
      },
      async handle(request) {
        return { status: 200, body: await service.describeNamespace(request.namespaceId) };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/dead-letters",
      operationId: "listDeadLetters",
      summary: "List the step tasks that ran out of attempts and wait for an operator.",
      query: pageQuerySchema,
      responses: {
        200: { description: "The dead letters, oldest first.", schema: deadLetterListSchema },
        ...commonErrors,
      },
      async handle(request) {
        const page = await service.listDeadLetters(request.namespaceId, request.parsedQuery);
        return { status: 200, body: page };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/dead-letters/{deadLetterId}/requeue",
      operationId: "requeueDeadLetter",
      summary: "Put a dead lettered step task back on its queue with a fresh retry budget.",
      responses: {
        200: { description: "The step task was enqueued again.", schema: requeueResponseSchema },
        ...commonErrors,
        404: deadLetterNotFound,
      },
      async handle(request) {
        const receipt = await service.requeueDeadLetter(
          request.namespaceId,
          deadLetterIdOf(request),
        );
        return { status: 200, body: receipt };
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
      summary: "Read one page of the run's event history. Follow nextCursor for the rest.",
      query: pageQuerySchema,
      responses: {
        200: { description: "The events in sequence order.", schema: historyResponseSchema },
        ...commonErrors,
        404: notFound,
      },
      async handle(request) {
        const page = await service.getHistory(
          request.namespaceId,
          runIdOf(request),
          request.parsedQuery,
        );
        return { status: 200, body: page };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/runs/{runId}/signal",
      operationId: "signalRun",
      summary: "Send a signal to an open run.",
      body: signalRequestSchema,
      responses: {
        200: {
          description: "The signal was recorded, or its signal id was used before.",
          schema: signalResponseSchema,
        },
        ...commonErrors,
        404: notFound,
        409: errorResponse("The run and every run it continued as are closed."),
      },
      async handle(request) {
        const receipt = await service.signalRun(
          request.namespaceId,
          runIdOf(request),
          request.parsedBody.name,
          request.parsedBody.payload,
          request.parsedBody.signalId,
        );
        return { status: 200, body: receipt };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/signal-with-start",
      operationId: "signalWithStart",
      summary:
        "Signal the run that holds a workflow key, starting it first when no run holds the key.",
      body: signalWithStartRequestSchema,
      responses: {
        200: {
          description: "An existing run was signalled.",
          schema: signalWithStartResponseSchema,
        },
        201: {
          description: "The run was started and signalled.",
          schema: signalWithStartResponseSchema,
        },
        ...commonErrors,
        409: errorResponse(
          "The run of the key is closed, or the key holds a run of another workflow type.",
        ),
      },
      async handle(request) {
        const body = request.parsedBody;
        const receipt = await service.signalWithStart(request.namespaceId, {
          workflowType: body.workflowType,
          workflowKey: body.workflowKey,
          input: body.input,
          signalName: body.signal.name,
          payload: body.signal.payload,
          signalId: body.signal.signalId,
        });
        return { status: receipt.created ? 201 : 200, body: receipt };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/events",
      operationId: "sendEvent",
      summary:
        "Send an external event: delivered to the runs waiting for its name and key, buffered for runs that wait later, and starting the runs of matching triggers.",
      body: sendEventRequestSchema,
      responses: {
        202: {
          description: "The event was stored and delivered.",
          schema: sendEventResponseSchema,
        },
        ...commonErrors,
      },
      async handle(request) {
        const body = request.parsedBody;
        const receipt = await service.sendEvent(request.namespaceId, {
          eventName: body.name,
          key: body.key,
          payload: body.payload ?? null,
          ...(body.bufferMs === undefined ? {} : { bufferMs: body.bufferMs }),
        });
        return {
          status: 202,
          body: {
            eventId: receipt.eventId,
            expiresAt: receipt.expiresAt.toISOString(),
            deliveredTo: receipt.deliveredTo,
            startedRunIds: receipt.startedRunIds,
          },
        };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/event-triggers",
      operationId: "createEventTrigger",
      summary: "Register a trigger: every matching event starts a run of the workflow type.",
      body: eventTriggerRequestSchema,
      responses: {
        201: { description: "The trigger was registered.", schema: eventTriggerSchema },
        ...commonErrors,
      },
      async handle(request) {
        const body = request.parsedBody;
        const trigger = await service.createEventTrigger(request.namespaceId, {
          eventName: body.eventName,
          workflowType: body.workflowType,
          ...(body.key === undefined ? {} : { key: body.key }),
        });
        return { status: 201, body: toTriggerBody(trigger) };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/event-triggers",
      operationId: "listEventTriggers",
      summary: "List the namespace's event triggers, oldest first.",
      responses: {
        200: { description: "The triggers.", schema: eventTriggerListSchema },
        ...commonErrors,
      },
      async handle(request) {
        const triggers = await service.listEventTriggers(request.namespaceId);
        return { status: 200, body: { triggers: triggers.map(toTriggerBody) } };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/runs/{runId}/updates/{updateName}",
      operationId: "updateRun",
      summary:
        "Send a validated update to an open run and wait for its result. A rejected update writes nothing.",
      body: updateRequestSchema,
      responses: {
        200: {
          description:
            "The update ran: status completed with its result, or failed with what the handler threw.",
          schema: updateResponseSchema,
        },
        202: {
          description: "The update was accepted, but the wait ended before it ran.",
          schema: updateResponseSchema,
        },
        ...commonErrors,
        400: errorResponse(
          "The request is malformed, the run has no such update, or its validator rejected the argument.",
        ),
        404: notFound,
        ...replayErrors,
      },
      async handle(request) {
        const outcome = await service.updateRun(
          request.namespaceId,
          runIdOf(request),
          request.params["updateName"] ?? "",
          request.parsedBody.argument ?? null,
          {
            ...(request.parsedBody.updateId === undefined
              ? {}
              : { updateId: request.parsedBody.updateId }),
            ...(request.parsedBody.waitMs === undefined
              ? {}
              : { waitMs: request.parsedBody.waitMs }),
          },
        );
        return { status: outcome.status === "accepted" ? 202 : 200, body: outcome };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/runs/{runId}/queries/{queryName}",
      operationId: "queryRun",
      summary: "Answer a query from the run's current state. Writes nothing.",
      query: queryParametersSchema,
      responses: {
        200: { description: "The query's answer.", schema: queryResponseSchema },
        ...commonErrors,
        400: errorResponse("The request is malformed or the run has no such query."),
        404: notFound,
        ...replayErrors,
      },
      async handle(request) {
        const result = await service.queryRun(
          request.namespaceId,
          runIdOf(request),
          request.params["queryName"] ?? "",
          parseQueryArgument(request.parsedQuery.argument),
        );
        return { status: 200, body: { result: result ?? null } };
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
  if (error instanceof DeadLetterNotFoundError) {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "dead letter not found" } },
    };
  }
  if (error instanceof RunNotFoundError) {
    return { status: 404, body: { error: { code: "not_found", message: "run not found" } } };
  }
  if (error instanceof UpdateRejectedError) {
    return { status: 400, body: { error: { code: "update_rejected", message: error.message } } };
  }
  if (error instanceof UnknownUpdateError) {
    return { status: 400, body: { error: { code: "unknown_update", message: error.message } } };
  }
  if (error instanceof UnknownQueryError) {
    return { status: 400, body: { error: { code: "unknown_query", message: error.message } } };
  }
  if (error instanceof RunHistoryCompactedError) {
    return { status: 409, body: { error: { code: "history_compacted", message: error.message } } };
  }
  if (error instanceof WorkflowNotLoadedError) {
    return {
      status: 501,
      body: { error: { code: "workflow_not_loaded", message: error.message } },
    };
  }
  if (error instanceof RunNotOpenError || error instanceof RunAlreadyClosedError) {
    return { status: 409, body: { error: { code: "run_closed", message: error.message } } };
  }
  if (error instanceof WorkflowKeyConflictError) {
    return {
      status: 409,
      body: { error: { code: "workflow_key_conflict", message: error.message } },
    };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: { error: { code: "idempotency_conflict", message: error.message } },
    };
  }
  if (error instanceof UnknownWorkflowTypeError) {
    return {
      status: 400,
      body: { error: { code: "unknown_workflow_type", message: error.message } },
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
