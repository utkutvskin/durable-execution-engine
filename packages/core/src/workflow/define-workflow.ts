import { validateConcurrencyRule, type ConcurrencyRule } from "../queue/concurrency-keys.ts";
import type { WorkflowHandler } from "./context.ts";
import type { WorkflowDefinition } from "./workflow-registry.ts";

/**
 * The options `defineWorkflow` accepts. `concurrency` limits how many runs
 * with the same key, evaluated from the run's input, hold a slot at once; a
 * run holds its slot while it has an open task and gives it up while it
 * sleeps or waits.
 */
export interface DefineWorkflowOptions<TInput> {
  readonly concurrency?: ConcurrencyRule<TInput>;
}

/**
 * Declares a workflow: pairs a `workflowType` name with its handler. The
 * result is registered with a `WorkflowRegistry` so a worker can look the
 * workflow up by name, and can also be run directly (`runWorkflowInMemory`
 * accepts a `WorkflowHandler` on its own for tests and examples). Rejects a
 * concurrency limit that is not a positive integer with
 * `InvalidConcurrencyRuleError`.
 */
export function defineWorkflow<TInput = unknown, TResult = unknown>(
  workflowType: string,
  handler: WorkflowHandler<TInput, TResult>,
  options: DefineWorkflowOptions<TInput> = {},
): WorkflowDefinition<TInput, TResult> {
  if (options.concurrency === undefined) {
    return { workflowType, handler };
  }
  return {
    workflowType,
    handler,
    concurrency: validateConcurrencyRule(`workflow "${workflowType}"`, options.concurrency),
  };
}
