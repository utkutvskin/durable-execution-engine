/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/api";

export {
  API_KEY_SCOPES,
  InvalidApiKeyError,
  LAST_USED_RESOLUTION_MS,
  NamespaceNotFoundError,
  createApiKeyStore,
  scopeAllows,
} from "./api-keys.ts";
export type {
  ApiKeyDescription,
  ApiKeyScope,
  ApiKeyStore,
  ApiKeyStoreOptions,
  AuthenticatedNamespace,
  IssueKeyOptions,
  IssuedApiKey,
  NamespaceSummary,
} from "./api-keys.ts";
export { ApiKeyNotFoundError, createAdminService } from "./admin.ts";
export type {
  AdminService,
  ApiKeyView,
  AuditEntryView,
  IssuedKeyView,
  NamespaceView,
  QuotaView,
} from "./admin.ts";
export { createAdminRoutes } from "./admin-routes.ts";
export { MAX_AUDIT_PAGE, createAuditLog } from "./audit-log.ts";
export type { AuditEntry, AuditEntryInput, AuditLog, AuditQuery } from "./audit-log.ts";
export { buildOpenApiDocument } from "./openapi.ts";
export type { JsonObject, OpenApiOptions } from "./openapi.ts";
export { validateOpenApiDocument } from "./openapi-validator.ts";
export { createQuotaGuard } from "./quota-guard.ts";
export type { QuotaGuard, QuotaGuardOptions, Rejection, RequestKind } from "./quota-guard.ts";
export {
  InvalidBackfillError,
  MAX_BACKFILL_TRIGGERS,
  QuarantinedTaskNotFoundError,
  createOperations,
} from "./operations.ts";
export type {
  BackfillRequest,
  CreateScheduleRequest,
  Operations,
  OperationsOptions,
  PauseDescription,
  PauseRequest,
  QuarantinedTaskDescription,
  ScheduleDescription,
  TriggerDescription,
} from "./operations.ts";
export { commonErrors, createRoutes, defineRoute, errorResponse, toErrorResult } from "./routes.ts";
export type {
  AuditDescription,
  AuditSpec,
  ErrorResult,
  RawRequest,
  ResponseSpec,
  Route,
  RouteDefinition,
  RouteResult,
} from "./routes.ts";
export {
  DeadLetterNotFoundError,
  IdempotencyConflictError,
  InvalidCursorError,
  UnknownWorkflowTypeError,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_READ_YOUR_WRITES_MS,
  MAX_PAGE_LIMIT,
  createRunService,
} from "./run-service.ts";
export type {
  DeadLetterPage,
  DeadLetterSummary,
  HistoryEntry,
  HistoryPage,
  PageInput,
  HistorySlice,
  NamespaceDescription,
  ListRunsInput,
  RunDescription,
  RunPage,
  RunService,
  RunServiceOptions,
  ResetRequest,
  StartBatchRequest,
  RunSummary,
  StartRunInput,
  StartRunResult,
} from "./run-service.ts";
export { createApiHandler, createApiServer } from "./server.ts";
export type { ApiHandler, ApiOptions, SideHandler } from "./server.ts";
