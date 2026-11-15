import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import {
  measureVisibilityQueries,
  seedVisibilityRuns,
  type VisibilityMeasurement,
} from "./visibility-queries.ts";

describe("visibility query plans", () => {
  let database: IsolatedSchema;
  let measured: VisibilityMeasurement[];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespaceId = await seedVisibilityRuns(database.pool, 20_000);
    measured = await measureVisibilityQueries(database.pool, namespaceId, 3);
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  function plan(query: string): VisibilityMeasurement {
    const found = measured.find((entry) => entry.query.startsWith(query));
    if (found === undefined) {
      throw new Error(`no measurement for ${query}`);
    }
    return found;
  }

  it("never reads workflow_runs sequentially for any measured query", () => {
    expect(measured).toHaveLength(6);
    for (const entry of measured) {
      expect(entry.plan.sequentialScans).toEqual([]);
    }
  });

  it("answers an attribute equality from the gin index", () => {
    expect(plan("customerId = 'c-17'").text).toContain("workflow_runs_search_attributes_idx");
    expect(plan("customerId = 'nobody'").plan.rowsReturned).toBe(0);
  });

  it("combines the status index and the gin index for the example of the backlog", () => {
    const example = plan("status = 'FAILED' and customerId = 'c-1'");
    expect(example.text).toMatch(/workflow_runs_(search_attributes|namespace_status_started)_idx/);
    expect(example.plan.executionMs).toBeLessThan(100);
  });

  it("filters an attribute range inside the status index order instead of sorting", () => {
    const range = plan("status = 'FAILED' and amount > 900");
    expect(range.text).toContain("workflow_runs_namespace_status_started_idx");
    expect(range.plan.rowsReturned).toBe(51);
  });
});
