import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.js";
import type { ClockSource } from "@dee/core";
import { startDevEnvironment, type DevEnvironment } from "./dev-environment.js";
import type { WorkflowModule } from "./modules.js";

/**
 * A dev environment over an isolated schema, for tests. `close` stops the
 * environment and drops the schema.
 */
export interface TestEnvironment {
  readonly database: IsolatedSchema;
  readonly environment: DevEnvironment;
  readonly errors: unknown[];
  close(): Promise<void>;
}

/**
 * Starts a `DevEnvironment` for `module` on a free port in a fresh schema.
 * Errors the engine survives are collected in `errors`.
 */
export async function startTestEnvironment(
  module: WorkflowModule,
  options: { readonly clock?: ClockSource } = {},
): Promise<TestEnvironment> {
  const database = await createIsolatedDatabase();
  const errors: unknown[] = [];
  const environment = await startDevEnvironment({
    pool: database.pool,
    module,
    port: 0,
    migrate: false,
    loopIntervalMs: 20,
    pollIntervalMs: 5,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    database,
    environment,
    errors,
    async close(): Promise<void> {
      await environment.stop();
      await database.close();
    },
  };
}

/**
 * The database url that reaches `schema` through `search_path`, for tests
 * of commands that open their own pool.
 */
export function urlForSchema(schema: string, base = process.env["DATABASE_URL"]): string {
  const url = new URL(base ?? "postgres://dee:dee@localhost:5432/dee");
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
