/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/api";

export { createApiKeyStore } from "./api-keys.js";
export type { ApiKeyStore, AuthenticatedNamespace, IssuedApiKey } from "./api-keys.js";
export { buildOpenApiDocument } from "./openapi.js";
export type { JsonObject, OpenApiOptions } from "./openapi.js";
export { validateOpenApiDocument } from "./openapi-validator.js";
export { createRoutes, toErrorResult } from "./routes.js";
export type { ErrorResult, RawRequest, ResponseSpec, Route, RouteResult } from "./routes.js";
export { IdempotencyConflictError, InvalidCursorError, createRunService } from "./run-service.js";
export type {
  HistoryEntry,
  ListRunsInput,
  RunDescription,
  RunPage,
  RunService,
  RunServiceOptions,
  RunSummary,
  StartRunInput,
  StartRunResult,
} from "./run-service.js";
export { createApiHandler, createApiServer } from "./server.js";
export type { ApiHandler, ApiOptions } from "./server.js";
