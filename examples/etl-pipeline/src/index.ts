import type { DemoContext, DemoReport } from "@dee/core";
import { runEtlDemo } from "./demo.ts";
import { createEtlSteps } from "./steps.ts";
import { createWarehouse, type Warehouse } from "./warehouse.ts";
import { partitionWorkflow, pipelineWorkflow } from "./workflows.ts";

export { runEtlDemo, scheduleNightlyEtl } from "./demo.ts";
export { STEP_TYPES, createEtlSteps } from "./steps.ts";
export type { SummaryInput, Transformed } from "./steps.ts";
export { createWarehouse, partitionId } from "./warehouse.ts";
export type { DaySummary, SourceRow, TargetRow, Warehouse, WarehouseOptions } from "./warehouse.ts";
export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_PARTITION_CONCURRENCY,
  ETL_PARTITION,
  ETL_PIPELINE,
  NIGHTLY_CRON,
  partitionWorkflow,
  pipelineWorkflow,
} from "./workflows.ts";
export type { PartitionInput, PartitionResult, PipelineInput } from "./workflows.ts";

/**
 * Creates the warehouse the demo expects: the first read of partition `p2`
 * fails.
 */
export function createDemoWarehouse(): Warehouse {
  return createWarehouse({ failFirstExtract: ["/p2"] });
}

/**
 * The warehouse the exported `steps` talk to.
 */
export const warehouse: Warehouse = createDemoWarehouse();

/**
 * The workflows this example contributes to a worker.
 */
export const workflows = [pipelineWorkflow, partitionWorkflow];

/**
 * The steps this example contributes to a worker, running against `warehouse`.
 */
export const steps = createEtlSteps(warehouse);

/**
 * What `wf example etl-pipeline` runs.
 */
export const demo = {
  description: "fan out a daily load over partitions, retry a flaky source and run it nightly",
  run: (context: DemoContext): Promise<DemoReport> => runEtlDemo(context, warehouse),
};
