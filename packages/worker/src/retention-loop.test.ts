import { describe, expect, it } from "vitest";
import type { RetentionReport, RetentionSweeper } from "@dee/core";
import { startRetentionLoop } from "./retention-loop.ts";
import { createDeferred, createVirtualTime, waitFor } from "./test-support.ts";

const emptyReport: RetentionReport = {
  tasksRetired: 0,
  runsPurged: 0,
  rows: {
    workflowTaskResults: 0,
    stepAttempts: 0,
    timers: 0,
    scheduleTriggers: 0,
    deadLetters: 0,
    taskHistory: 0,
    concurrencySlotHistory: 0,
  },
  namespaces: [],
};

function fakeSweeper(sweep: () => Promise<RetentionReport>): RetentionSweeper {
  return {
    sweep,
    retireFinishedTasks: () => Promise.resolve(0),
    purgeClosedRuns: () => Promise.resolve(emptyReport),
  };
}

describe("retention loop", () => {
  it("sweeps once per interval and reports each sweep", async () => {
    const time = createVirtualTime();
    const reports: RetentionReport[] = [];
    let sweeps = 0;
    const loop = startRetentionLoop({
      sweeper: fakeSweeper(() => {
        sweeps += 1;
        return Promise.resolve({ ...emptyReport, tasksRetired: sweeps });
      }),
      intervalMs: 2000,
      timers: time.timers,
      onSweep: (report) => reports.push(report),
    });

    time.advance(1999);
    expect(sweeps).toBe(0);
    time.advance(1);
    await waitFor(() => reports.length === 1);
    time.advance(2000);
    await waitFor(() => reports.length === 2);
    await loop.stop();

    expect(reports.map((report) => report.tasksRetired)).toEqual([1, 2]);
  });

  it("survives a failing sweep and keeps its schedule", async () => {
    const time = createVirtualTime();
    const errors: unknown[] = [];
    let calls = 0;
    const loop = startRetentionLoop({
      sweeper: fakeSweeper(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("db down")) : Promise.resolve(emptyReport);
      }),
      intervalMs: 1000,
      timers: time.timers,
      onError: (error) => errors.push(error),
    });

    time.advance(1000);
    await waitFor(() => errors.length === 1);
    time.advance(1000);
    await waitFor(() => calls === 2);
    await loop.stop();

    expect(errors).toEqual([new Error("db down")]);
  });

  it("waits for a sweep in progress on stop and schedules no other", async () => {
    const time = createVirtualTime();
    const gate = createDeferred();
    let calls = 0;
    const loop = startRetentionLoop({
      sweeper: fakeSweeper(() => {
        calls += 1;
        return gate.promise.then(() => emptyReport);
      }),
      intervalMs: 1000,
      timers: time.timers,
    });

    time.advance(1000);
    await waitFor(() => calls === 1);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    time.advance(10_000);

    expect(calls).toBe(1);
  });

  it("rejects an interval that is not a positive integer", () => {
    expect(() =>
      startRetentionLoop({
        sweeper: fakeSweeper(() => Promise.resolve(emptyReport)),
        intervalMs: 0,
      }),
    ).toThrow(RangeError);
  });
});
