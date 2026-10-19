import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { explainHotQueries, seedHotTables, type QueryPlan } from "./hot-queries.js";

describe("hot query plans", () => {
  let database: IsolatedSchema;
  let plans: Map<string, QueryPlan>;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const seeded = await seedHotTables(database.pool, { runs: 20_000 });
    const explained = await explainHotQueries(database.pool, seeded);
    plans = new Map(explained.map((plan) => [plan.name, plan]));
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  it("explains every hot query", () => {
    expect([...plans.keys()]).toEqual([
      "dequeue",
      "sequence check",
      "read history",
      "reclaim expired leases",
      "stalled runs",
      "due timers",
      "list runs",
      "list open runs",
      "queue depth gauge",
      "active workers gauge",
    ]);
  });

  it("serves the dequeue from the index order without sorting the open tasks", () => {
    const dequeue = plans.get("dequeue");
    expect(dequeue?.nodeTypes).not.toContain("Sort");
    expect(dequeue?.sequentialScans).toEqual([]);
    expect(dequeue?.rowsReturned).toBe(8);
  });

  it("finds open runs for the stalled run scan without scanning every run or task", () => {
    const stalled = plans.get("stalled runs");
    expect(stalled?.sequentialScans).not.toContain("workflow_runs");
    expect(stalled?.sequentialScans).not.toContain("tasks");
    expect(stalled?.sequentialScans).not.toContain("run_events");
  });

  it("reads a run's history and sequence through the run_events index", () => {
    expect(plans.get("read history")?.sequentialScans).toEqual([]);
    expect(
      plans.get("sequence check")?.sequentialScans.filter((table) => table === "run_events"),
    ).toEqual([]);
  });

  it("polls due timers and reclaims leases through indexes", () => {
    expect(plans.get("due timers")?.sequentialScans).toEqual([]);
    expect(plans.get("reclaim expired leases")?.sequentialScans).toEqual([]);
  });

  it("lists runs of a namespace through the namespace index", () => {
    expect(plans.get("list runs")?.sequentialScans).toEqual([]);
    expect(plans.get("list open runs")?.sequentialScans).toEqual([]);
  });
});
