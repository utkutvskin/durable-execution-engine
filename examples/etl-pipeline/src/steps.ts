import { defineStep, type StepDefinition } from "@dee/core";
import type { DaySummary, SourceRow, TargetRow, Warehouse } from "./warehouse.js";

/**
 * The step types of the pipeline, as `ctx.step()` names them.
 */
export const STEP_TYPES = {
  listPartitions: "etl.list-partitions",
  extract: "etl.extract",
  transform: "etl.transform",
  load: "etl.load",
  summarize: "etl.summarize",
} as const;

/**
 * What the transform step produces: the rows that passed and the number that
 * were rejected.
 */
export interface Transformed {
  readonly rows: readonly TargetRow[];
  readonly rejected: number;
}

/**
 * What the summarize step needs: the per partition counts of one day.
 */
export interface SummaryInput {
  readonly day: string;
  readonly partitions: readonly {
    readonly extracted: number;
    readonly loaded: number;
    readonly rejected: number;
  }[];
}

function formatAmount(amountCents: number): string {
  return `${String(Math.trunc(amountCents / 100))}.${String(amountCents % 100).padStart(2, "0")}`;
}

/**
 * Builds the steps of the pipeline over `warehouse`. Extract retries a
 * flaky source with a short backoff; load is an upsert, so a step that runs
 * twice leaves the destination as it was.
 */
export function createEtlSteps(warehouse: Warehouse): readonly StepDefinition<never>[] {
  const listPartitions = defineStep(STEP_TYPES.listPartitions, {
    handler: (input: { day: string }) => warehouse.listPartitions(input.day),
  });
  const extract = defineStep(STEP_TYPES.extract, {
    retry: { initialIntervalMs: 100, backoffCoefficient: 2, maxAttempts: 4 },
    handler: (input: { partition: string }): SourceRow[] => warehouse.extract(input.partition),
  });
  const transform = defineStep(STEP_TYPES.transform, {
    handler: (input: { day: string; rows: readonly SourceRow[] }): Transformed => {
      const valid = input.rows.filter((row) => row.amountCents > 0);
      return {
        rows: valid.map((row) => ({
          id: row.id,
          amount: formatAmount(row.amountCents),
          currency: row.currency,
          day: input.day,
        })),
        rejected: input.rows.length - valid.length,
      };
    },
  });
  const load = defineStep(STEP_TYPES.load, {
    handler: (input: { rows: readonly TargetRow[] }) => ({
      inserted: warehouse.load(input.rows),
      attempted: input.rows.length,
    }),
  });
  const summarize = defineStep(STEP_TYPES.summarize, {
    handler: (input: SummaryInput): DaySummary => {
      const summary: DaySummary = {
        day: input.day,
        partitions: input.partitions.length,
        extracted: input.partitions.reduce((sum, entry) => sum + entry.extracted, 0),
        loaded: input.partitions.reduce((sum, entry) => sum + entry.loaded, 0),
        rejected: input.partitions.reduce((sum, entry) => sum + entry.rejected, 0),
      };
      warehouse.writeSummary(input.day, summary);
      return summary;
    },
  });
  return [listPartitions, extract, transform, load, summarize];
}
