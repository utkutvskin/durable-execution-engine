import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowModule } from "@dee/cli";
import { createShiftableClock } from "../../../packages/worker/src/chaos/world.js";
import {
  startTestEnvironment,
  type TestEnvironment,
} from "../../../packages/cli/src/test-support.js";
import { demo, steps as demoSteps } from "./index.js";
import { scheduleNightlyEtl } from "./demo.js";
import { createEtlSteps } from "./steps.js";
import { createWarehouse, type DaySummary, type Warehouse } from "./warehouse.js";
import { ETL_PIPELINE, partitionWorkflow, pipelineWorkflow } from "./workflows.js";

describe("etl pipeline", () => {
  let current: TestEnvironment | undefined;

  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  async function boot(
    warehouse: Warehouse,
    clock = createShiftableClock(),
  ): Promise<TestEnvironment> {
    const module: WorkflowModule = {
      workflows: [pipelineWorkflow, partitionWorkflow],
      steps: createEtlSteps(warehouse),
    };
    current = await startTestEnvironment(module, { clock });
    return current;
  }

  it("loads every valid row of every partition and writes the day summary", async () => {
    const warehouse = createWarehouse();
    const { environment } = await boot(warehouse);
    const run = await environment.client.waitForClose(
      await environment.client.start(ETL_PIPELINE, { day: "2026-01-15" }),
    );
    expect(run.status).toBe("COMPLETED");
    const summary: DaySummary = {
      day: "2026-01-15",
      partitions: 4,
      extracted: 100,
      loaded: 92,
      rejected: 8,
    };
    expect(run.result).toEqual(summary);
    expect(warehouse.summaries().get("2026-01-15")).toEqual(summary);
    expect(warehouse.loadedRows().size).toBe(92);
  });

  it("writes each partition in batches of the requested size", async () => {
    const warehouse = createWarehouse({ partitions: 2 });
    const { environment } = await boot(warehouse);
    await environment.client.waitForClose(
      await environment.client.start(ETL_PIPELINE, { day: "2026-01-16", batchSize: 5 }),
    );
    expect(warehouse.loadedRows().size).toBe(46);
    expect(warehouse.loadCalls()).toBe(2 * Math.ceil(23 / 5));
  });

  it("retries a flaky partition without reading the others again", async () => {
    const warehouse = createWarehouse({ failFirstExtract: ["/p2"] });
    const clock = createShiftableClock();
    const { environment } = await boot(warehouse, clock);
    const runId = await environment.client.start(ETL_PIPELINE, { day: "2026-01-17" });
    for (let round = 0; round < 300; round += 1) {
      clock.shift(200);
      if ((await environment.client.describe(runId)).status !== "RUNNING") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect((await environment.client.describe(runId)).status).toBe("COMPLETED");
    expect(warehouse.extractCalls().get("2026-01-17/p2")).toBe(2);
    expect(warehouse.extractCalls().get("2026-01-17/p0")).toBe(1);
    expect(warehouse.loadedRows().size).toBe(92);
  });

  it("leaves the destination unchanged when the same day runs twice", async () => {
    const warehouse = createWarehouse();
    const { environment } = await boot(warehouse);
    for (let pass = 0; pass < 2; pass += 1) {
      const run = await environment.client.waitForClose(
        await environment.client.start(ETL_PIPELINE, { day: "2026-01-18" }),
      );
      expect(run.status).toBe("COMPLETED");
    }
    expect(warehouse.loadedRows().size).toBe(92);
  });

  it("runs the nightly schedule when the clock reaches two o'clock", async () => {
    const warehouse = createWarehouse();
    const clock = createShiftableClock();
    const { environment } = await boot(warehouse, clock);
    await scheduleNightlyEtl(environment);
    const now = clock.now();
    const nextTwo = new Date(now);
    nextTwo.setUTCHours(2, 0, 1, 0);
    if (nextTwo <= now) {
      nextTwo.setUTCDate(nextTwo.getUTCDate() + 1);
    }
    clock.shift(nextTwo.getTime() - now.getTime());
    for (let round = 0; round < 400; round += 1) {
      const page = await environment.client.listRuns({ workflowType: ETL_PIPELINE });
      if (page.runs.some((run) => run.status === "COMPLETED")) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const page = await environment.client.listRuns({ workflowType: ETL_PIPELINE });
    expect(page.runs.filter((run) => run.status === "COMPLETED").length).toBeGreaterThanOrEqual(1);
    expect(warehouse.summaries().size).toBe(1);
    expect(warehouse.loadedRows().size).toBe(92);
  });

  it("plays the whole demo story with every claim holding", async () => {
    current = await startTestEnvironment({
      workflows: [pipelineWorkflow, partitionWorkflow],
      steps: demoSteps,
    });
    const lines: string[] = [];
    const report = await demo.run({
      client: current.environment.client,
      schedules: current.environment.schedules,
      namespaceId: current.environment.namespaceId,
      log: (line) => lines.push(line),
    });
    expect(report).toEqual({ ok: true });
    expect(lines.filter((line) => line.includes("bad"))).toEqual([]);
  }, 30_000);
});
