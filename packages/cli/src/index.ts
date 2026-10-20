/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/cli";

export { ApiError, CliError } from "./errors.js";
export { HELP_TEXT, main } from "./main.js";
export type { CliHooks } from "./main.js";
export { processIo } from "./io.js";
export type { CliIo } from "./io.js";
export { createApiClient } from "./run-client.js";
export type {
  ApiClientOptions,
  HistoryItem,
  ListFilter,
  RunClient,
  RunListPage,
  RunSnapshot,
  WaitOptions,
} from "./run-client.js";
export { startDevEnvironment } from "./dev-environment.js";
export type { DevEnvironment, DevEnvironmentOptions } from "./dev-environment.js";
export {
  EXAMPLE_NAMES,
  loadExample,
  loadExampleDemo,
  loadWorkflowModule,
  mergeModules,
  toWorkflowModule,
} from "./modules.js";
export type {
  DemoContext,
  DemoReport,
  ExampleDemo,
  ExampleName,
  WorkflowModule,
} from "./modules.js";
export { DEV_STATE_PATH, readDevState, resolveClientConfig, writeDevState } from "./config.js";
export type { ClientConfig, DevState } from "./config.js";
export { ensureDatabase, findComposeDirectory } from "./database.js";
export type { DatabaseEffects, EnsureDatabaseInput } from "./database.js";
