import { defineWorkflow } from "@dee/core";
import { STEP_TYPES, type Transformed } from "./steps.js";
import type { DaySummary, SourceRow } from "./warehouse.js";

/**
 * The names the workflows are started under.
 */
export const ETL_PIPELINE = "etl-pipeline";

/**
 * The name of the per partition child workflow.
 */
export const ETL_PARTITION = "etl-partition";

/**
 * The nightly cron expression: two o'clock UTC.
 */
export const NIGHTLY_CRON = "0 2 * * *";

/**
 * How many partitions run at the same time when the input does not say.
 */
export const DEFAULT_PARTITION_CONCURRENCY = 2;

/**
 * How many rows one `etl.load` step writes when the input does not say.
 */
export const DEFAULT_BATCH_SIZE = 10;

/**
 * The input of `etl-pipeline`. `day` defaults to the day of `ctx.now()`, which
 * is what lets a cron schedule start the same input every night.
 */
export interface PipelineInput {
  readonly day?: string;
  readonly batchSize?: number;
  readonly concurrency?: number;
}

/**
 * The input of `etl-partition`.
 */
export interface PartitionInput {
  readonly day: string;
  readonly partition: string;
  readonly batchSize: number;
}

/**
 * What a partition run reports.
 */
export interface PartitionResult {
  readonly partition: string;
  readonly extracted: number;
  readonly loaded: number;
  readonly rejected: number;
}

/**
 * Extracts one partition, transforms it and loads it in batches.
 */
export const partitionWorkflow = defineWorkflow(
  ETL_PARTITION,
  async (ctx, input: PartitionInput): Promise<PartitionResult> => {
    const rows = await ctx.step<SourceRow[]>(STEP_TYPES.extract, { partition: input.partition });
    const transformed = await ctx.step<Transformed>(STEP_TYPES.transform, {
      day: input.day,
      rows,
    });
    let loaded = 0;
    for (let offset = 0; offset < transformed.rows.length; offset += input.batchSize) {
      const outcome = await ctx.step<{ inserted: number; attempted: number }>(STEP_TYPES.load, {
        rows: transformed.rows.slice(offset, offset + input.batchSize),
      });
      loaded += outcome.attempted;
    }
    return {
      partition: input.partition,
      extracted: rows.length,
      loaded,
      rejected: transformed.rejected,
    };
  },
);

/**
 * The pipeline: lists the partitions of a day, runs one child workflow per
 * partition with bounded parallelism and writes the day's summary.
 */
export const pipelineWorkflow = defineWorkflow(
  ETL_PIPELINE,
  async (ctx, input: PipelineInput): Promise<DaySummary> => {
    const day = input.day ?? ctx.now().toISOString().slice(0, 10);
    const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
    const partitions = await ctx.step<string[]>(STEP_TYPES.listPartitions, { day });
    const results = await ctx.all(
      partitions.map(
        (partition) => () =>
          ctx.executeChild<PartitionResult>(ETL_PARTITION, { day, partition, batchSize }),
      ),
      { concurrency: input.concurrency ?? DEFAULT_PARTITION_CONCURRENCY },
    );
    return ctx.step<DaySummary>(STEP_TYPES.summarize, { day, partitions: results });
  },
);
