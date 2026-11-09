/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/api";

export { InvalidApiKeyError, createApiKeyStore } from "./api-keys.ts";
export type { ApiKeyStore, AuthenticatedNamespace, IssuedApiKey } from "./api-keys.ts";
export { buildOpenApiDocument } from "./openapi.ts";
export type { JsonObject, OpenApiOptions } from "./openapi.ts";
export { validateOpenApiDocument } from "./openapi-validator.ts";
export { createQuotaGuard } from "./quota-guard.ts";
export type { QuotaGuard, QuotaGuardOptions, Rejection, RequestKind } from "./quota-guard.ts";
export { createRoutes, toErrorResult } from "./routes.ts";
export type { ErrorResult, RawRequest, ResponseSpec, Route, RouteResult } from "./routes.ts";
export {
  DeadLetterNotFoundError,
  IdempotencyConflictError,
  InvalidCursorError,
  UnknownWorkflowTypeError,
  DEFAULT_PAGE_LIMIT,
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
  RunSummary,
  StartRunInput,
  StartRunResult,
} from "./run-service.ts";
export { createApiHandler, createApiServer } from "./server.ts";
export type { ApiHandler, ApiOptions, SideHandler } from "./server.ts";
