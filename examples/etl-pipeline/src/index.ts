import type { DemoContext, DemoReport } from "@dee/cli";
import { runEtlDemo } from "./demo.js";
import { createEtlSteps } from "./steps.js";
import { createWarehouse, type Warehouse } from "./warehouse.js";
import { partitionWorkflow, pipelineWorkflow } from "./workflows.js";

export { runEtlDemo, scheduleNightlyEtl } from "./demo.js";
export { STEP_TYPES, createEtlSteps } from "./steps.js";
export type { SummaryInput, Transformed } from "./steps.js";
export { createWarehouse, partitionId } from "./warehouse.js";
export type { DaySummary, SourceRow, TargetRow, Warehouse, WarehouseOptions } from "./warehouse.js";
export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_PARTITION_CONCURRENCY,
  ETL_PARTITION,
  ETL_PIPELINE,
  NIGHTLY_CRON,
  partitionWorkflow,
  pipelineWorkflow,
} from "./workflows.js";
export type { PartitionInput, PartitionResult, PipelineInput } from "./workflows.js";

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
