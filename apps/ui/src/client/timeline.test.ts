import { describe, expect, it } from "vitest";
import { buildTimeline, mergeEntries, type HistoryEntry } from "./timeline.js";

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

  it("labels accepted and completed updates and marks a failed one with its error", () => {
    const items = buildTimeline([
      entry(1, "2026-03-01T10:00:00.000Z", {
        type: "update_accepted",
        updateId: "u-1",
        updateName: "add",
        argument: "apple",
      }),
      entry(2, "2026-03-01T10:00:00.100Z", {
        type: "update_completed",
        updateId: "u-1",
        result: 1,
      }),
      entry(3, "2026-03-01T10:00:00.200Z", {
        type: "update_completed",
        updateId: "u-2",
        result: null,
        error: { name: "Error", message: "no room" },
      }),
    ]);
    expect(items.map((item) => [item.label, item.summary, item.tone])).toEqual([
      ["update accepted", "add (u-1)", "neutral"],
      ["update completed", "u-1", "good"],
      ["update completed", "u-2: Error: no room", "good"],
    ]);
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

describe("mergeEntries", () => {
  const started = entry(1, "2026-03-01T10:00:00.000Z", { type: "run_started" });
  const scheduled = entry(2, "2026-03-01T10:00:01.000Z", { type: "step_scheduled" });
  const completed = entry(3, "2026-03-01T10:00:02.000Z", { type: "step_completed" });

  it("keeps an entry that arrives twice once", () => {
    expect(mergeEntries([started, scheduled], [scheduled, completed])).toEqual([
      started,
      scheduled,
      completed,
    ]);
  });

  it("orders entries by sequence number whatever order they arrive in", () => {
    expect(mergeEntries([completed], [started, scheduled]).map((e) => e.sequenceNumber)).toEqual([
      1, 2, 3,
    ]);
  });

  it("keeps the first copy of a repeated sequence number", () => {
    const later = entry(2, "2026-03-01T10:00:09.000Z", { type: "timer_fired" });
    expect(mergeEntries([scheduled], [later])).toEqual([scheduled]);
  });

  it("shows a replayed history once in the timeline", () => {
    const items = buildTimeline([started, scheduled, started, scheduled, completed]);
    expect(items.map((item) => item.sequenceNumber)).toEqual([1, 2, 3]);
  });
});
