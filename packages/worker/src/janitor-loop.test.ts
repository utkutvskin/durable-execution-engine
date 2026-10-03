import { describe, expect, it } from "vitest";
import type { Janitor, SweepReport } from "@dee/core";
import { createRecoveryMetrics } from "@dee/core";
import { startJanitorLoop } from "./janitor-loop.js";
import { createDeferred, createVirtualTime, waitFor } from "./test-support.js";

const emptyReport: SweepReport = { reclaimed: [], stalled: [], recovered: [] };

function fakeJanitor(sweep: Janitor["sweep"]): Janitor {
  return {
    metrics: createRecoveryMetrics(),
    sweep,
    reclaimOrphanedLeases: () => Promise.resolve([]),
    findStalledRuns: () => Promise.resolve([]),
    recoverStalledRuns: () => Promise.resolve([]),
  };
}

describe("janitor loop", () => {
  it("sweeps once per interval", async () => {
    const time = createVirtualTime();
    let sweeps = 0;
    const loop = startJanitorLoop({
      janitor: fakeJanitor(() => {
        sweeps += 1;
        return Promise.resolve(emptyReport);
      }),
      intervalMs: 5000,
      timers: time.timers,
    });

    time.advance(4999);
    expect(sweeps).toBe(0);
    time.advance(1);
    await waitFor(() => sweeps === 1);
    time.advance(5000);
    await waitFor(() => sweeps === 2);
    await loop.stop();
  });

  it("passes the stalled run options to every sweep and reports the result", async () => {
    const time = createVirtualTime();
    const received: unknown[] = [];
    const reports: SweepReport[] = [];
    const loop = startJanitorLoop({
      janitor: fakeJanitor((options) => {
        received.push(options);
        return Promise.resolve(emptyReport);
      }),
      intervalMs: 1000,
      stalledRuns: { graceMs: 60_000, queueName: "default/workflows" },
      timers: time.timers,
      onSweep: (report) => reports.push(report),
    });

    time.advance(1000);
    await waitFor(() => reports.length === 1);
    await loop.stop();

    expect(received).toEqual([{ graceMs: 60_000, queueName: "default/workflows" }]);
    expect(reports).toEqual([emptyReport]);
  });

  it("survives a failing sweep and keeps its schedule", async () => {
    const time = createVirtualTime();
    const errors: unknown[] = [];
    let calls = 0;
    const loop = startJanitorLoop({
      janitor: fakeJanitor(() => {
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
    expect(errors).toHaveLength(1);
  });

  it("never runs two sweeps at once", async () => {
    const time = createVirtualTime();
    const gate = createDeferred();
    let active = 0;
    let peak = 0;
    const loop = startJanitorLoop({
      janitor: fakeJanitor(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return emptyReport;
      }),
      intervalMs: 100,
      timers: time.timers,
    });

    time.advance(100);
    await waitFor(() => active === 1);
    time.advance(1000);
    gate.resolve();
    await loop.stop();
    expect(peak).toBe(1);
  });

  it("stops scheduling sweeps after stop", async () => {
    const time = createVirtualTime();
    let sweeps = 0;
    const loop = startJanitorLoop({
      janitor: fakeJanitor(() => {
        sweeps += 1;
        return Promise.resolve(emptyReport);
      }),
      intervalMs: 100,
      timers: time.timers,
    });

    await loop.stop();
    time.advance(10_000);

    expect(sweeps).toBe(0);
    expect(time.pendingDelays()).toEqual([]);
  });

  it("rejects an interval that is not a positive integer", () => {
    expect(() =>
      startJanitorLoop({ janitor: fakeJanitor(() => Promise.resolve(emptyReport)), intervalMs: 0 }),
    ).toThrow(RangeError);
  });
});
