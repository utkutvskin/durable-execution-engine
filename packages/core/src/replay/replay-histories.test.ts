import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../event-store/events.ts";
import { defineWorkflow } from "../workflow/define-workflow.ts";
import {
  createHistoryExport,
  HISTORY_EXPORT_FORMAT,
  InvalidHistoryExportError,
  parseHistoryExport,
  type HistoryExport,
} from "./history-export.ts";
import { formatReplayResult, replayHistories } from "./replay-histories.ts";

const RUN_ID = "0f6a3a9e-6a54-4c32-9d55-6f0f5a2c1b11";

function exportOf(events: readonly WorkflowEvent[], runId = RUN_ID): HistoryExport {
  return createHistoryExport({
    runId,
    exportedAt: new Date("2026-03-01T00:00:00.000Z"),
    events: events.map((event, index) => ({
      sequenceNumber: index + 1,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      version: 1,
      event,
    })),
  });
}

const input = { orderId: "order-1" };

const openHistory: readonly WorkflowEvent[] = [
  { type: "run_started", workflowType: "order", input },
  { type: "step_scheduled", stepId: "step-1", stepType: "charge", input },
  { type: "step_completed", stepId: "step-1", result: { charged: true } },
  {
    type: "timer_started",
    timerId: "timer-1",
    fireAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60_000,
  },
];

const completedHistory: readonly WorkflowEvent[] = [
  ...openHistory,
  { type: "timer_fired", timerId: "timer-1" },
  { type: "step_scheduled", stepId: "step-2", stepType: "ship", input },
  { type: "step_completed", stepId: "step-2", result: { shipped: true } },
  { type: "run_completed", result: { shipped: true } },
];

const original = defineWorkflow<typeof input>("order", async (ctx, order) => {
  await ctx.step("charge", order);
  await ctx.sleep(60_000);
  return ctx.step("ship", order);
});

describe("history exports", () => {
  it("builds an export with the envelope, the workflow type and every event version", () => {
    const exported = exportOf(completedHistory);
    expect(exported).toMatchObject({
      format: HISTORY_EXPORT_FORMAT,
      formatVersion: 1,
      runId: RUN_ID,
      workflowType: "order",
      exportedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(exported.events.map((entry) => entry.version)).toEqual(completedHistory.map(() => 1));
    expect(
      parseHistoryExport(JSON.parse(JSON.stringify(exported))).events.map((e) => e.event),
    ).toEqual(completedHistory);
  });

  it("refuses to export a compacted history or one with a gap", () => {
    expect(() =>
      createHistoryExport({
        runId: RUN_ID,
        events: [{ sequenceNumber: 5, createdAt: new Date(), event: { type: "step_completed" } }],
      }),
    ).toThrow(/compacted run cannot be exported/);
    expect(() =>
      createHistoryExport({
        runId: RUN_ID,
        events: [
          { sequenceNumber: 1, createdAt: new Date(), event: completedHistory[0] ?? { type: "" } },
          { sequenceNumber: 3, createdAt: new Date(), event: { type: "run_completed" } },
        ],
      }),
    ).toThrow(InvalidHistoryExportError);
  });

  it("names the file and the event when an event does not match the schema", () => {
    const exported = exportOf(completedHistory);
    const broken = {
      ...exported,
      events: exported.events.map((entry) =>
        entry.sequenceNumber === 3 ? { ...entry, event: { type: "step_completed" } } : entry,
      ),
    };
    expect(() => parseHistoryExport(broken, "broken.json")).toThrow(
      /^broken\.json: event 3: step_completed does not match the event schema/,
    );
  });

  it("refuses a file that is not an export, or one of a newer envelope", () => {
    expect(() => parseHistoryExport({ history: [] }, "old.json")).toThrow(/not a history export/);
    expect(() => parseHistoryExport({ ...exportOf(openHistory), formatVersion: 2 })).toThrow(
      /newer than 1/,
    );
  });

  it("reads an event of a newer version forward-compatibly", () => {
    const exported = exportOf(openHistory);
    const newer = {
      ...exported,
      events: exported.events.map((entry) =>
        entry.sequenceNumber === 2
          ? { ...entry, version: 2, event: { ...entry.event, queue: "fast" } }
          : entry,
      ),
    };
    expect(parseHistoryExport(newer).events[1]).toMatchObject({
      version: 2,
      event: { type: "step_scheduled", stepId: "step-1", stepType: "charge", input },
    });
    expect(parseHistoryExport(newer).events[1]?.event).not.toHaveProperty("queue");
  });
});

describe("replayHistories", () => {
  it("passes a completed and an open history replayed against the code that wrote them", async () => {
    const report = await replayHistories(
      [original],
      [
        { source: "completed.json", history: exportOf(completedHistory) },
        { source: "open.json", history: exportOf(openHistory) },
      ],
    );
    expect(report).toMatchObject({ passed: 2, failed: 0 });
    expect(report.results[0]).toEqual({
      source: "completed.json",
      runId: RUN_ID,
      workflowType: "order",
      eventCount: 8,
      passed: true,
    });
  });

  it("passes compatible changes: a new result shape and a step after the open frontier", async () => {
    const compatible = defineWorkflow<typeof input>("order", async (ctx, order) => {
      await ctx.step("charge", order);
      await ctx.sleep(60_000);
      const shipped = await ctx.step("ship", order);
      await ctx.step("notify", order);
      return { shipped, version: 2 };
    });
    const report = await replayHistories(
      [compatible],
      [{ source: "open.json", history: exportOf(openHistory) }],
    );
    expect(report.failed).toBe(0);

    const reshaped = defineWorkflow<typeof input>("order", async (ctx, order) => {
      await ctx.step("charge", order);
      await ctx.sleep(60_000);
      return { shipped: await ctx.step("ship", order), version: 2 };
    });
    const completed = await replayHistories(
      [reshaped],
      [{ source: "completed.json", history: exportOf(completedHistory) }],
    );
    expect(completed.failed).toBe(0);
  });

  it("fails a changed step type, naming the run and the event", async () => {
    const changed = defineWorkflow<typeof input>("order", async (ctx, order) => {
      await ctx.step("charge", order);
      await ctx.sleep(60_000);
      return ctx.step("ship-express", order);
    });
    const report = await replayHistories(
      [changed],
      [{ source: "completed.json", history: exportOf(completedHistory) }],
    );
    const result = report.results[0];
    expect(report.failed).toBe(1);
    expect(result?.problem).toMatchObject({
      kind: "non_determinism",
      sequenceNumber: 6,
      eventType: "step_scheduled",
    });
    expect(formatReplayResult(result ?? { source: "", eventCount: 0, passed: true })).toMatch(
      new RegExp(
        `^FAIL  run ${RUN_ID} \\(completed\\.json\\): non determinism at event 6 \\(step_scheduled\\): `,
      ),
    );
  });

  it("fails a removed timer at the event that recorded it", async () => {
    const removed = defineWorkflow<typeof input>("order", async (ctx, order) => {
      await ctx.step("charge", order);
      return ctx.step("ship", order);
    });
    const report = await replayHistories(
      [removed],
      [{ source: "open.json", history: exportOf(openHistory) }],
    );
    expect(report.results[0]?.problem).toMatchObject({
      kind: "non_determinism",
      sequenceNumber: 4,
      eventType: "timer_started",
    });
  });

  it("fails code that no longer closes a completed run the way the history did", async () => {
    const longer = defineWorkflow<typeof input>("order", async (ctx, order) => {
      await ctx.step("charge", order);
      await ctx.sleep(60_000);
      await ctx.step("ship", order);
      return ctx.step("invoice", order);
    });
    const report = await replayHistories(
      [longer],
      [{ source: "completed.json", history: exportOf(completedHistory) }],
    );
    expect(report.results[0]?.problem).toMatchObject({
      kind: "outcome_mismatch",
      sequenceNumber: 8,
      eventType: "run_completed",
    });
    expect(report.results[0]?.problem?.message).toContain("would issue schedule_step");
  });

  it("reports an unknown workflow type and an unreadable file without throwing", async () => {
    const report = await replayHistories(
      [],
      [
        { source: "completed.json", history: exportOf(completedHistory) },
        { source: "junk.json", history: { nope: true } },
      ],
    );
    expect(report.results.map((result) => result.problem?.kind)).toEqual([
      "unknown_workflow",
      "invalid_history",
    ]);
    expect(report.failed).toBe(2);
  });

  it("fails a history whose patch the code no longer consults", async () => {
    const patched = defineWorkflow<typeof input>("order", async (ctx, order) => {
      if (ctx.patched("express")) {
        return ctx.step("ship-express", order);
      }
      return ctx.step("ship", order);
    });
    const unpatched = defineWorkflow<typeof input>("order", async (ctx, order) =>
      ctx.step("ship-express", order),
    );
    const history: WorkflowEvent[] = [
      { type: "run_started", workflowType: "order", input },
      { type: "patch_recorded", patchId: "express", buildId: "build-1" },
      { type: "step_scheduled", stepId: "step-1", stepType: "ship-express", input },
    ];
    const passing = await replayHistories(
      [patched],
      [{ source: "p.json", history: exportOf(history) }],
    );
    expect(passing.failed).toBe(0);
    const report = await replayHistories(
      [unpatched],
      [{ source: "p.json", history: exportOf(history) }],
      { buildId: "build-2" },
    );
    expect(report.results[0]?.problem).toMatchObject({
      kind: "version_mismatch",
      sequenceNumber: 2,
      eventType: "patch_recorded",
    });
  });

  it("replays ctx.random() with the run id seed a worker uses", async () => {
    const random = defineWorkflow<typeof input>("order", async (ctx, order) => {
      const pick = ctx.random() < 0.5 ? "charge" : "charge-alt";
      return ctx.step(pick, order);
    });
    const report = await replayHistories(
      [random],
      ["charge", "charge-alt"].map((stepType) => ({
        source: `${stepType}.json`,
        history: exportOf([
          { type: "run_started", workflowType: "order", input },
          { type: "step_scheduled", stepId: "step-1", stepType, input },
        ]),
      })),
    );
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
  });
});
