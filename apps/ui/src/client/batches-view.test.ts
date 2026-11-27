import { describe, expect, it } from "vitest";
import { batchRequestOf, formatBatchProgress } from "./batches-view.js";

const blank = { operation: "terminate", query: "", signalName: "", payload: "", rate: "" };

describe("the batch form", () => {
  it("builds a terminate batch over a trimmed query with a rate", () => {
    expect(batchRequestOf({ ...blank, query: " status = 'FAILED' ", rate: "25" })).toEqual({
      operation: "terminate",
      query: "status = 'FAILED'",
      reason: "started from the ui",
      runsPerSecond: 25,
    });
  });

  it("needs a signal name and a json payload for a signal batch", () => {
    expect(batchRequestOf({ ...blank, operation: "signal" })).toBe(
      "a signal batch needs a signal name",
    );
    expect(batchRequestOf({ ...blank, operation: "signal", signalName: "go", payload: "{" })).toBe(
      "the payload is not valid json",
    );
    expect(
      batchRequestOf({ ...blank, operation: "signal", signalName: "go", payload: '{"a":1}' }),
    ).toMatchObject({ signal: { name: "go", payload: { a: 1 } } });
  });

  it("cuts a reset batch before each run's failed step and refuses a bad rate", () => {
    expect(batchRequestOf({ ...blank, operation: "reset" })).toMatchObject({
      resetPoint: { kind: "failed-step" },
    });
    expect(batchRequestOf({ ...blank, rate: "-1" })).toMatch(/positive number/);
    expect(batchRequestOf({ ...blank, operation: "delete" })).toBe('unknown operation "delete"');
  });

  it("shows a batch's progress", () => {
    expect(
      formatBatchProgress({
        batchId: "b",
        operation: "cancel",
        query: "",
        runId: "r",
        status: "RUNNING",
        total: 10,
        applied: 6,
        skipped: 1,
        remaining: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("6 applied, 1 skipped, 3 left of 10");
  });
});
