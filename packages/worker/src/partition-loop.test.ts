import { describe, expect, it } from "vitest";
import type { PartitionMaintainer, PartitionMaintenanceReport } from "@dee/core";
import { startPartitionLoop } from "./partition-loop.ts";
import { createDeferred, createVirtualTime, waitFor } from "./test-support.ts";

function fakeMaintainer(runOnce: () => Promise<PartitionMaintenanceReport>): PartitionMaintainer {
  return { runOnce, listPartitions: () => Promise.resolve([]) };
}

function reportCreating(name: string): PartitionMaintenanceReport {
  return { created: [name], dropped: [], kept: [] };
}

describe("partition loop", () => {
  it("maintains the partitions at once and then once per interval", async () => {
    const time = createVirtualTime();
    const reports: PartitionMaintenanceReport[] = [];
    let runs = 0;
    const loop = startPartitionLoop({
      maintainer: fakeMaintainer(() => {
        runs += 1;
        return Promise.resolve(reportCreating(`p${String(runs)}`));
      }),
      intervalMs: 5000,
      timers: time.timers,
      onReport: (report) => reports.push(report),
    });

    await waitFor(() => reports.length === 1);
    time.advance(4999);
    expect(runs).toBe(1);
    time.advance(1);
    await waitFor(() => reports.length === 2);
    await loop.stop();

    expect(reports.map((report) => report.created)).toEqual([["p1"], ["p2"]]);
  });

  it("survives a failing run and keeps its schedule", async () => {
    const time = createVirtualTime();
    const errors: unknown[] = [];
    let calls = 0;
    const loop = startPartitionLoop({
      maintainer: fakeMaintainer(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("lock timeout"))
          : Promise.resolve(reportCreating("p"));
      }),
      intervalMs: 1000,
      timers: time.timers,
      onError: (error) => errors.push(error),
    });

    await waitFor(() => errors.length === 1);
    time.advance(1000);
    await waitFor(() => calls === 2);
    await loop.stop();

    expect(errors).toEqual([new Error("lock timeout")]);
  });

  it("waits for a run in progress on stop and schedules no other", async () => {
    const time = createVirtualTime();
    const gate = createDeferred();
    let calls = 0;
    const loop = startPartitionLoop({
      maintainer: fakeMaintainer(() => {
        calls += 1;
        return gate.promise.then(() => reportCreating("p"));
      }),
      intervalMs: 1000,
      timers: time.timers,
    });

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
      startPartitionLoop({
        maintainer: fakeMaintainer(() => Promise.resolve(reportCreating("p"))),
        intervalMs: 1.5,
      }),
    ).toThrow(RangeError);
  });
});
