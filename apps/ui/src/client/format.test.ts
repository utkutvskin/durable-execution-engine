import { describe, expect, it } from "vitest";
import { formatConcurrency } from "./format.js";

describe("formatConcurrency", () => {
  it("says nothing for a run without a concurrency key", () => {
    expect(formatConcurrency(undefined)).toBeUndefined();
  });

  it("tells a run waiting for a slot how many runs hold its key", () => {
    expect(
      formatConcurrency({
        key: "customer-1",
        limit: 2,
        holders: 2,
        holdsSlot: false,
        waitingForSlot: true,
      }),
    ).toBe(
      'waiting for a slot of concurrency key "customer-1" (limit 2): 2 of 2 held by other runs',
    );
  });

  it("tells a run that holds a slot or sleeps without one", () => {
    const base = { key: "c", limit: 1, holders: 1, waitingForSlot: false };
    expect(formatConcurrency({ ...base, holdsSlot: true })).toBe(
      'holds a slot of concurrency key "c" (limit 1)',
    );
    expect(formatConcurrency({ ...base, holdsSlot: false })).toBe(
      'uses concurrency key "c" (limit 1), holds no slot now',
    );
  });
});
