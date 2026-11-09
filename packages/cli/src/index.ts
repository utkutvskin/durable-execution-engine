/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/cli";

export { ApiError, CliError } from "./errors.ts";
export { HELP_TEXT, main } from "./main.ts";
export type { CliHooks } from "./main.ts";
export { processIo } from "./io.ts";
export type { CliIo } from "./io.ts";
export { createApiClient } from "./run-client.ts";
export type {
  ApiClientOptions,
  HistoryItem,
  ListFilter,
  RunClient,
  RunListPage,
  RunSnapshot,
  WaitOptions,
} from "./run-client.ts";
export { startDevEnvironment } from "./dev-environment.ts";
export type { DevEnvironment, DevEnvironmentOptions } from "./dev-environment.ts";
export {
  EXAMPLE_NAMES,
  loadExample,
  loadExampleDemo,
  loadWorkflowModule,
  mergeModules,
  toWorkflowModule,
} from "./modules.ts";
export type { ExampleDemo, ExampleName, WorkflowModule } from "./modules.ts";
export { DEV_STATE_PATH, readDevState, resolveClientConfig, writeDevState } from "./config.ts";
export type { ClientConfig, DevState } from "./config.ts";
export { ensureDatabase, findComposeDirectory } from "./database.ts";
export type { DatabaseEffects, EnsureDatabaseInput } from "./database.ts";
export type { DemoContext, DemoReport } from "@dee/core";
