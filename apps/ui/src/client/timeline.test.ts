import { describe, expect, it } from "vitest";
import { buildTimeline, type HistoryEntry } from "./timeline.js";

function entry(sequenceNumber: number, at: string, event: HistoryEntry["event"]): HistoryEntry {
  return { sequenceNumber, createdAt: at, event };
}

describe("buildTimeline", () => {
  it("labels events, keeps their order and measures offsets from the first event", () => {
    const items = buildTimeline([
      entry(1, "2026-03-01T10:00:00.000Z", {
        type: "run_started",
        workflowType: "order",
        input: {},
      }),
      entry(2, "2026-03-01T10:00:01.500Z", {
        type: "step_scheduled",
        stepId: "step-1",
        stepType: "reserve",
        input: {},
      }),
      entry(3, "2026-03-01T10:01:00.000Z", { type: "run_completed", result: 1 }),
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "run started",
      "step scheduled",
      "run completed",
    ]);
    expect(items.map((item) => item.offsetMs)).toEqual([0, 1500, 60_000]);
    expect(items[0]?.summary).toBe("order");
    expect(items[1]?.summary).toBe("reserve (step-1)");
  });

  it("marks failures bad, retries warn and completions good", () => {
    const items = buildTimeline([
      entry(1, "2026-03-01T10:00:00.000Z", {
        type: "step_attempt_failed",
        stepId: "s",
        attempt: 2,
        error: { name: "Boom", message: "card declined" },
        retryAt: null,
      }),
      entry(2, "2026-03-01T10:00:00.000Z", {
        type: "run_failed",
        error: { name: "Boom", message: "gave up" },
      }),
      entry(3, "2026-03-01T10:00:00.000Z", { type: "run_completed", result: null }),
    ]);
    expect(items.map((item) => item.tone)).toEqual(["warn", "bad", "good"]);
    expect(items[0]?.summary).toBe("s attempt 2: Boom: card declined");
    expect(items[1]?.summary).toBe("Boom: gave up");
  });

  it("describes signals by name and keeps the raw event for the detail panel", () => {
    const [item] = buildTimeline([
      entry(4, "2026-03-01T10:00:00.000Z", {
        type: "signal_received",
        signalName: "approve",
        payload: { ok: true },
      }),
    ]);
    expect(item?.summary).toBe("approve");
    expect(item?.event).toEqual({
      type: "signal_received",
      signalName: "approve",
      payload: { ok: true },
    });
  });

  it("falls back to the type name for an event it does not know", () => {
    const [item] = buildTimeline([
      entry(1, "2026-03-01T10:00:00.000Z", { type: "future_event_kind" }),
    ]);
    expect(item?.label).toBe("future event kind");
    expect(item?.tone).toBe("neutral");
  });

  it("lines a later batch up with the run start when given the origin", () => {
    const origin = Date.parse("2026-03-01T10:00:00.000Z");
    const [item] = buildTimeline(
      [entry(9, "2026-03-01T10:00:05.000Z", { type: "timer_fired", timerId: "timer-1" })],
      origin,
    );
    expect(item?.offsetMs).toBe(5000);
  });

  it("returns nothing for an empty history", () => {
    expect(buildTimeline([])).toEqual([]);
  });
});
