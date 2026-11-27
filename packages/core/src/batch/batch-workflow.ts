import { defineStep, type StepDefinition } from "../workflow/define-step.ts";
import { defineWorkflow } from "../workflow/define-workflow.ts";
import type { WorkflowDefinition } from "../workflow/workflow-registry.ts";
import {
  BATCH_WORKFLOW_TYPE,
  type BatchOperationRunner,
  type BatchProgress,
} from "./batch-operations.ts";

/**
 * The input of a batch workflow run.
 */
export interface BatchWorkflowInput {
  readonly batchId: string;
}

/**
 * How many pages one run of a batch workflow handles before it continues as
 * new, which keeps its history short however many targets the batch has.
 */
export const BATCH_PAGES_PER_RUN = 50;

/**
 * The workflow and the steps that execute batch operations, as
 * `createBatchOperationDefinitions` builds them.
 */
export interface BatchOperationDefinitions {
  readonly workflow: WorkflowDefinition<BatchWorkflowInput, BatchProgress>;
  readonly steps: readonly [
    StepDefinition<
      BatchWorkflowInput,
      { readonly pageSize: number; readonly pageIntervalMs: number }
    >,
    StepDefinition<BatchWorkflowInput & { readonly limit: number }, BatchProgress>,
  ];
}

/**
 * Builds the batch workflow (`BATCH_WORKFLOW_TYPE`) over `runner`. A run
 * reads the batch's plan, then applies one page of targets per step and
 * sleeps the plan's interval between pages, a durable timer, so a batch
 * survives a worker crash and resumes where it stopped. After
 * `BATCH_PAGES_PER_RUN` pages it continues as new. It completes with the
 * batch's progress once no target is pending. Its steps retry for as long
 * as the database refuses them.
 */
export function createBatchOperationDefinitions(
  runner: BatchOperationRunner,
): BatchOperationDefinitions {
  const retry = { maxAttempts: 1000, initialIntervalMs: 500, maxIntervalMs: 30_000 };
  const plan = defineStep<
    BatchWorkflowInput,
    { readonly pageSize: number; readonly pageIntervalMs: number }
  >("dee.batch.plan", {
    handler: (input) => runner.plan(input.batchId),
    retry,
  });
  const apply = defineStep<BatchWorkflowInput & { readonly limit: number }, BatchProgress>(
    "dee.batch.apply",
    {
      handler: (input) => runner.applyPage(input.batchId, input.limit),
      retry,
    },
  );
  const workflow = defineWorkflow<BatchWorkflowInput, BatchProgress>(
    BATCH_WORKFLOW_TYPE,
    async (ctx, input) => {
      const pages = await ctx.step(plan, input);
      for (let page = 1; ; page += 1) {
        const progress = await ctx.step(apply, { batchId: input.batchId, limit: pages.pageSize });
        if (progress.remaining === 0) {
          return progress;
        }
        if (page >= BATCH_PAGES_PER_RUN) {
          return ctx.continueAsNew(input);
        }
        if (pages.pageIntervalMs > 0) {
          await ctx.sleep(pages.pageIntervalMs);
        }
      }
    },
  );
  return { workflow, steps: [plan, apply] };
}
