import type { WorkflowHandler } from "./context.js";

/**
 * A workflow registered under `workflowType`: its handler, as returned by
 * `defineWorkflow`.
 */
export interface WorkflowDefinition<TInput = unknown, TResult = unknown> {
  readonly workflowType: string;
  readonly handler: WorkflowHandler<TInput, TResult>;
}

/**
 * Looks up workflow definitions by the `workflowType` string a run is
 * started with. Workflows are registered by name rather than passed as
 * closures, so a worker can look one up and run it without the caller
 * that started the run being in the same process.
 */
export interface WorkflowRegistry {
  register<TInput, TResult>(definition: WorkflowDefinition<TInput, TResult>): void;
  get(workflowType: string): WorkflowDefinition | undefined;
}

/**
 * Creates an empty, in-memory `WorkflowRegistry`.
 */
export function createWorkflowRegistry(): WorkflowRegistry {
  const definitions = new Map<string, WorkflowDefinition>();
  return {
    register<TInput, TResult>(definition: WorkflowDefinition<TInput, TResult>): void {
      if (definitions.has(definition.workflowType)) {
        throw new Error(`workflow type "${definition.workflowType}" is already registered`);
      }
      definitions.set(definition.workflowType, definition as WorkflowDefinition);
    },
    get(workflowType: string): WorkflowDefinition | undefined {
      return definitions.get(workflowType);
    },
  };
}
