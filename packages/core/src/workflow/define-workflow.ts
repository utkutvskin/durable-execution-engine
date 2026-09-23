import type { WorkflowHandler } from "./context.js";
import type { WorkflowDefinition } from "./workflow-registry.js";

/**
 * Declares a workflow: pairs a `workflowType` name with its handler. The
 * result is registered with a `WorkflowRegistry` so a worker can look the
 * workflow up by name, and can also be run directly (`runWorkflowInMemory`
 * accepts a `WorkflowHandler` on its own for tests and examples).
 */
export function defineWorkflow<TInput = unknown, TResult = unknown>(
  workflowType: string,
  handler: WorkflowHandler<TInput, TResult>,
): WorkflowDefinition<TInput, TResult> {
  return { workflowType, handler };
}
