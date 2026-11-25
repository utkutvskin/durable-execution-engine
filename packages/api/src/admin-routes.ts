import { z } from "zod";
import { API_KEY_SCOPES } from "./api-keys.ts";
import type { AdminService } from "./admin.ts";
import { MAX_AUDIT_PAGE } from "./audit-log.ts";
import {
  commonErrors,
  defineRoute,
  errorResponse,
  type RawRequest,
  type Route,
  type RouteResult,
} from "./routes.ts";

const NAMESPACE_NAME = /^[A-Za-z0-9][\w.-]{0,62}$/;

const namespaceNameSchema = z.string().regex(NAMESPACE_NAME, {
  message: "1 to 63 letters, digits, '.', '_' or '-', starting with a letter or digit",
});

const scopeSchema = z.enum(API_KEY_SCOPES as [string, ...string[]]).meta({
  description: "read: reads only. operate: also changes work in the namespace. admin: everything.",
});

const namespaceViewSchema = z
  .object({
    namespaceId: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
    activeKeys: z.number().int(),
  })
  .meta({ id: "AdminNamespace" });

const namespaceListSchema = z
  .object({ namespaces: z.array(namespaceViewSchema) })
  .meta({ id: "AdminNamespaceList" });

const createNamespaceSchema = z
  .object({ name: namespaceNameSchema })
  .meta({ id: "CreateNamespaceRequest" });

const createNamespaceResponseSchema = z
  .object({ namespace: namespaceViewSchema, created: z.boolean() })
  .meta({ id: "CreateNamespaceResponse" });

const keyViewSchema = z
  .object({
    keyId: z.uuid(),
    namespace: z.string(),
    label: z.string(),
    scope: scopeSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ApiKey" });

const keyListSchema = z.object({ keys: z.array(keyViewSchema) }).meta({ id: "ApiKeyList" });

const issueKeySchema = z
  .object({
    scope: scopeSchema,
    label: z.string().max(255).optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .meta({ id: "IssueKeyRequest" });

const issuedKeySchema = z
  .object({
    key: z.string().meta({ description: "The secret. It is shown only in this response." }),
    keyId: z.uuid(),
    namespace: z.string(),
    label: z.string(),
    scope: scopeSchema,
    expiresAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "IssuedApiKey" });

const quotaLimitsSchema = z
  .object({
    maxConcurrentRuns: z.number().int().min(0).nullable(),
    maxPendingTasks: z.number().int().min(0).nullable(),
    ratePerSecond: z.number().positive().nullable(),
    burst: z.number().int().positive().nullable(),
  })
  .meta({ id: "QuotaLimits" });

const quotaViewSchema = z
  .object({
    namespace: z.string(),
    quota: quotaLimitsSchema,
    usage: z.object({ openRuns: z.number().int(), pendingTasks: z.number().int() }),
  })
  .meta({ id: "NamespaceQuota" });

const setQuotaSchema = quotaLimitsSchema.partial().meta({
  id: "SetQuotaRequest",
  description: "The limits to change. null removes a limit, a limit left out keeps its value.",
});

const auditEntrySchema = z
  .object({
    id: z.string(),
    occurredAt: z.iso.datetime(),
    actor: z.object({
      keyId: z.uuid(),
      label: z.string(),
      namespace: z.string(),
      scope: scopeSchema,
    }),
    namespace: z.string().nullable(),
    action: z.string(),
    target: z.string().nullable(),
    details: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "AuditEntry" });

const auditListSchema = z
  .object({ entries: z.array(auditEntrySchema), nextCursor: z.string().optional() })
  .meta({ id: "AuditEntryList" });

const auditQuerySchema = z.object({
  namespace: z.string().optional(),
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE).optional(),
});

const namespaceNotFound = errorResponse("The namespace does not exist.");

function namespaceOf(request: RawRequest): string {
  return request.params["namespace"] ?? "";
}

function keyIdOfResult(result: RouteResult): string | null {
  const body = result.body as { keyId?: unknown };
  return typeof body.keyId === "string" ? body.keyId : null;
}

/**
 * Builds the `/v1/admin` routes over `admin`. Every one needs an `admin`
 * key, acts on the namespace named in the path or body rather than the
 * caller's, and every write is audited.
 */
export function createAdminRoutes(admin: AdminService): readonly Route[] {
  return [
    defineRoute({
      method: "get",
      path: "/v1/admin/namespaces",
      operationId: "adminListNamespaces",
      summary: "List every namespace.",
      scope: "admin",
      responses: {
        200: { description: "The namespaces by name.", schema: namespaceListSchema },
        ...commonErrors,
      },
      async handle() {
        return { status: 200, body: { namespaces: await admin.listNamespaces() } };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/admin/namespaces",
      operationId: "adminCreateNamespace",
      summary: "Create a namespace. Creating one that exists changes nothing.",
      scope: "admin",
      body: createNamespaceSchema,
      audit: {
        action: "namespace.create",
        describe: (request) => {
          const name = (request.body as { name?: unknown }).name;
          return { namespace: typeof name === "string" ? name : null, target: null, details: {} };
        },
      },
      responses: {
        200: {
          description: "The namespace existed already.",
          schema: createNamespaceResponseSchema,
        },
        201: { description: "The namespace was created.", schema: createNamespaceResponseSchema },
        ...commonErrors,
      },
      async handle(request) {
        const result = await admin.createNamespace(request.parsedBody.name);
        return { status: result.created ? 201 : 200, body: result };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/admin/namespaces/{namespace}/keys",
      operationId: "adminListKeys",
      summary: "List a namespace's api keys, without their secrets.",
      scope: "admin",
      responses: {
        200: { description: "The keys, oldest first.", schema: keyListSchema },
        ...commonErrors,
        404: namespaceNotFound,
      },
      async handle(request) {
        return { status: 200, body: { keys: await admin.listKeys(namespaceOf(request)) } };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/admin/namespaces/{namespace}/keys",
      operationId: "adminIssueKey",
      summary: "Issue an api key for an existing namespace. The secret is shown once.",
      scope: "admin",
      body: issueKeySchema,
      audit: {
        action: "key.issue",
        describe: (request, result) => ({
          namespace: namespaceOf(request),
          target: keyIdOfResult(result),
          details: request.body as Record<string, unknown>,
        }),
      },
      responses: {
        201: { description: "The key was issued.", schema: issuedKeySchema },
        ...commonErrors,
        400: errorResponse("The request is malformed, or the expiry is not in the future."),
        404: namespaceNotFound,
      },
      async handle(request) {
        const issued = await admin.issueKey(namespaceOf(request), {
          scope: request.parsedBody.scope as (typeof API_KEY_SCOPES)[number],
          ...(request.parsedBody.label === undefined ? {} : { label: request.parsedBody.label }),
          ...(request.parsedBody.expiresAt === undefined
            ? {}
            : { expiresAt: new Date(request.parsedBody.expiresAt) }),
        });
        return { status: 201, body: issued };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/admin/keys/{keyId}/revoke",
      operationId: "adminRevokeKey",
      summary: "Revoke an api key. It is refused from the next request on.",
      scope: "admin",
      audit: {
        action: "key.revoke",
        describe: (request, result) => ({
          namespace: (result.body as { namespace?: string }).namespace ?? null,
          target: request.params["keyId"] ?? null,
          details: {},
        }),
      },
      responses: {
        200: { description: "The key was revoked.", schema: keyViewSchema },
        ...commonErrors,
        404: errorResponse("The key does not exist or was revoked already."),
      },
      async handle(request) {
        return { status: 200, body: await admin.revokeKey(request.params["keyId"] ?? "") };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/admin/namespaces/{namespace}/quota",
      operationId: "adminGetQuota",
      summary: "Read a namespace's limits and what it uses of them.",
      scope: "admin",
      responses: {
        200: { description: "The quota and usage.", schema: quotaViewSchema },
        ...commonErrors,
        404: namespaceNotFound,
      },
      async handle(request) {
        return { status: 200, body: await admin.getQuota(namespaceOf(request)) };
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/admin/namespaces/{namespace}/quota",
      operationId: "adminSetQuota",
      summary: "Change a namespace's limits.",
      scope: "admin",
      body: setQuotaSchema,
      audit: {
        action: "quota.set",
        describe: (request) => ({ namespace: namespaceOf(request), target: null }),
      },
      responses: {
        200: { description: "The quota after the change.", schema: quotaViewSchema },
        ...commonErrors,
        404: namespaceNotFound,
      },
      async handle(request) {
        const changes = Object.fromEntries(
          Object.entries(request.parsedBody).filter(([, value]) => value !== undefined),
        );
        return { status: 200, body: await admin.setQuota(namespaceOf(request), changes) };
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/admin/audit-log",
      operationId: "adminListAuditLog",
      summary: "Read the audit log of admin and operator actions, newest first.",
      scope: "admin",
      query: auditQuerySchema,
      responses: {
        200: { description: "One page of entries.", schema: auditListSchema },
        ...commonErrors,
      },
      async handle(request) {
        const limit = request.parsedQuery.limit ?? 100;
        const entries = await admin.listAuditLog({
          namespace: request.parsedQuery.namespace,
          before: request.parsedQuery.cursor,
          limit,
        });
        const last = entries.at(-1);
        return {
          status: 200,
          body: {
            entries,
            ...(entries.length === limit && last !== undefined ? { nextCursor: last.id } : {}),
          },
        };
      },
    }),
  ];
}
