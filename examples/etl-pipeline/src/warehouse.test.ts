import { describe, expect, it } from "vitest";
import { createWarehouse, partitionId } from "./warehouse.js";

describe("in memory warehouse", () => {
  it("lists a stable set of partitions per day", () => {
    const warehouse = createWarehouse({ partitions: 3 });
    expect(warehouse.listPartitions("2026-01-01")).toEqual([
      partitionId("2026-01-01", 0),
      partitionId("2026-01-01", 1),
      partitionId("2026-01-01", 2),
    ]);
  });

  it("serves rows with every tenth amount invalid", () => {
    const warehouse = createWarehouse({ rowsPerPartition: 20 });
    const rows = warehouse.extract("d/p0");
    expect(rows).toHaveLength(20);
    expect(rows.filter((row) => row.amountCents < 0)).toHaveLength(2);
  });

  it("fails the first extract of a flaky partition only", () => {
    const warehouse = createWarehouse({ failFirstExtract: ["/p1"] });
    expect(() => warehouse.extract("d/p1")).toThrow("timed out");
    expect(warehouse.extract("d/p1")).toHaveLength(25);
    expect(warehouse.extract("d/p0")).toHaveLength(25);
    expect(warehouse.extractCalls().get("d/p1")).toBe(2);
  });

  it("upserts rows by id so a repeated load adds nothing", () => {
    const warehouse = createWarehouse();
    const rows = [{ id: "a", amount: "1.00", currency: "EUR", day: "d" }];
    expect(warehouse.load(rows)).toBe(1);
    expect(warehouse.load(rows)).toBe(0);
    expect(warehouse.loadedRows().size).toBe(1);
    expect(warehouse.loadCalls()).toBe(2);
  });
});
