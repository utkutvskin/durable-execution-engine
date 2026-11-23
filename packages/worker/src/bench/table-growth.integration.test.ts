import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { measureTableGrowth, type TableGrowthSample } from "./table-growth.ts";

const IN_FLIGHT = 16;
const RUNS_PER_READING = 25;
const READINGS = 10;

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 6000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the runs did not complete in time");
}

describe("tasks table growth", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  const errors: unknown[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    errors.length = 0;
  });

  async function grow(retention: boolean): Promise<readonly TableGrowthSample[]> {
    let readings = 0;
    let target = 0;
    return measureTableGrowth({
      pool: database.pool,
      namespaceId,
      queueName: retention ? "growth-retained" : "growth-kept",
      inFlight: IN_FLIGHT,
      loopIntervalMs: 20,
      pollIntervalMs: 2,
      retention: retention ? { finishedTaskGraceMs: 0, closedRunRetentionMs: 0 } : false,
      next: async (runsCompleted) => {
        target += RUNS_PER_READING;
        await waitUntil(() => runsCompleted() >= target);
      },
      onError: (error) => {
        errors.push(error);
      },
      stopWhen: () => {
        readings += 1;
        return readings >= READINGS;
      },
    });
  }

  it("keeps tasks flat while runs keep completing with retention on", async () => {
    const samples = await grow(true);

    const last = samples.at(-1);
    expect(last?.runsCompleted).toBeGreaterThanOrEqual(READINGS * RUNS_PER_READING);
    const bound = 2 * IN_FLIGHT + 4 * RUNS_PER_READING;
    expect(Math.max(...samples.map((sample) => sample.taskRows))).toBeLessThan(bound);
    const secondHalf = samples.slice(READINGS / 2).map((sample) => sample.taskRows);
    expect(Math.max(...secondHalf)).toBeLessThan(bound);
    expect(Math.max(...samples.map((sample) => sample.historyRows))).toBeLessThan(
      4 * READINGS * RUNS_PER_READING,
    );
    expect(errors).toEqual([]);
  });

  it("grows tasks with every completed run with retention off", async () => {
    const samples = await grow(false);

    const last = samples.at(-1);
    expect(last?.taskRows).toBeGreaterThanOrEqual(4 * (last?.runsCompleted ?? 0));
    expect(last?.historyRows).toBe(0);
    const rows = samples.map((sample) => sample.taskRows);
    expect(rows).toEqual([...rows].sort((left, right) => left - right));
  });
});
