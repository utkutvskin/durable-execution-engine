import type { DemoContext, DemoReport } from "@dee/cli";
import { ETL_PIPELINE, NIGHTLY_CRON, type PipelineInput } from "./workflows.js";
import type { DaySummary, Warehouse } from "./warehouse.js";

const DAY = "2026-01-15";

/**
 * Creates the nightly schedule of the pipeline in `namespaceId` and returns
 * its id. The input is empty, so every run processes the day of its own
 * start.
 */
export async function scheduleNightlyEtl(
  context: Pick<DemoContext, "schedules" | "namespaceId">,
  name = "nightly-etl",
): Promise<string> {
  const record = await context.schedules.create({
    namespaceId: context.namespaceId,
    name,
    cronExpression: NIGHTLY_CRON,
    workflowType: ETL_PIPELINE,
    input: {},
    overlapPolicy: "allow_all",
  });
  return record.id;
}

/**
 * The story `wf example etl-pipeline` plays: a day is processed with four
 * partitions in parallel, one of which hits a flaky source and is retried;
 * the same day is run again to show the load is idempotent; and a nightly
 * cron schedule is backfilled over three past nights. Every claim is checked
 * against the warehouse. The warehouse must fail the first extract of
 * partition `p2`, as the one `createDemoWarehouse` builds does.
 */
export async function runEtlDemo(context: DemoContext, warehouse: Warehouse): Promise<DemoReport> {
  const { client, log } = context;
  const problems: string[] = [];
  warehouse.reset();

  function expect(condition: boolean, message: string): void {
    log(`${condition ? "  ok " : "  bad"} ${message}`);
    if (!condition) {
      problems.push(message);
    }
  }

  log("1. one day is split into four partitions that run in parallel");
  const first = await client.waitForClose(
    await client.start(ETL_PIPELINE, { day: DAY } satisfies PipelineInput),
  );
  const summary = first.result as DaySummary | undefined;
  expect(first.status === "COMPLETED", "the pipeline run completed");
  expect(summary?.partitions === 4, "four partitions were processed");
  expect(summary?.extracted === 100 && summary.rejected === 8, "100 rows read, 8 rejected");
  expect(warehouse.loadedRows().size === 92, "92 rows reached the destination");

  log("2. a flaky source is retried without redoing finished partitions");
  expect((warehouse.extractCalls().get(`${DAY}/p2`) ?? 0) === 2, "partition p2 was read twice");
  expect((warehouse.extractCalls().get(`${DAY}/p0`) ?? 0) === 1, "partition p0 was read once");

  log("3. running the same day again leaves the destination unchanged");
  const again = await client.waitForClose(
    await client.start(ETL_PIPELINE, { day: DAY } satisfies PipelineInput),
  );
  expect(again.status === "COMPLETED", "the second run completed");
  expect(warehouse.loadedRows().size === 92, "the destination still holds 92 rows");

  log("4. a nightly schedule is backfilled over three past nights");
  const scheduleId = await scheduleNightlyEtl(context, `nightly-${String(Date.now())}`);
  const now = new Date();
  const report = await context.schedules.backfill(
    scheduleId,
    new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    now,
  );
  const runIds = report.triggers.flatMap((trigger) =>
    trigger.runId === undefined ? [] : [trigger.runId],
  );
  expect(runIds.length >= 3, "the backfill started a run for each night");
  const closed = await Promise.all(runIds.map((runId) => client.waitForClose(runId)));
  expect(
    closed.every((run) => run.status === "COMPLETED"),
    "every scheduled run completed",
  );
  const today = now.toISOString().slice(0, 10);
  expect(warehouse.summaries().has(today), "the scheduled runs wrote a summary for their own day");
  return problems.length === 0 ? { ok: true } : { ok: false, problem: problems.join("; ") };
}
