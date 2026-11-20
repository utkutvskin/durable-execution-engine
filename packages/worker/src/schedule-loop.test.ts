import { describe, expect, it } from "vitest";
import type { ScheduleManager, ScheduleTickReport } from "@dee/core";
import { startScheduleLoop } from "./schedule-loop.ts";
import { createVirtualTime, waitFor } from "./test-support.ts";

const emptyReport: ScheduleTickReport = { triggers: [] };

function fakeManager(catchUp: ScheduleManager["catchUp"]): ScheduleManager {
  const unused = (): never => {
    throw new Error("not used by the loop");
  };
  return {
    catchUp,
    tick: () => Promise.resolve({ triggers: [] }),
    nextDueAt: () => Promise.resolve(undefined),
    create: unused,
    get: unused,
    list: unused,
    listTriggers: unused,
    pause: unused,
    resume: unused,
    backfill: unused,
  };
}

describe("schedule loop", () => {
  it("catches up immediately on start, before the first interval elapses", async () => {
    const time = createVirtualTime();
    let passes = 0;
    const loop = startScheduleLoop({
      manager: fakeManager(() => {
        passes += 1;
        return Promise.resolve(emptyReport);
      }),
      intervalMs: 1000,
      timers: time.timers,
    });
    await waitFor(() => passes === 1);
    await loop.stop();
    expect(passes).toBe(1);
  });

  it("runs one pass per interval after the first", async () => {
    const time = createVirtualTime();
    let passes = 0;
    const loop = startScheduleLoop({
      manager: fakeManager(() => {
        passes += 1;
        return Promise.resolve(emptyReport);
      }),
      intervalMs: 1000,
      timers: time.timers,
    });
    await waitFor(() => passes === 1);
    time.advance(999);
    expect(passes).toBe(1);
    time.advance(1);
    await waitFor(() => passes === 2);
    await loop.stop();
  });

  it("survives a failing pass and reports it", async () => {
    const time = createVirtualTime();
    const errors: unknown[] = [];
    let passes = 0;
    const loop = startScheduleLoop({
      manager: fakeManager(() => {
        passes += 1;
        return passes === 1 ? Promise.reject(new Error("db down")) : Promise.resolve(emptyReport);
      }),
      intervalMs: 1000,
      timers: time.timers,
      onError: (error) => errors.push(error),
    });
    await waitFor(() => errors.length === 1);
    time.advance(1000);
    await waitFor(() => passes === 2);
    await loop.stop();
    expect((errors[0] as Error).message).toBe("db down");
  });

  it("fires pending starts on every pass, even when the schedule catch-up fails", async () => {
    const time = createVirtualTime();
    const errors: unknown[] = [];
    let fired = 0;
    const loop = startScheduleLoop({
      manager: fakeManager(() => Promise.reject(new Error("schedules down"))),
      pendingStarts: {
        fireDue: () => {
          fired += 1;
          return fired === 2
            ? Promise.reject(new Error("pending down"))
            : Promise.resolve({ debounced: [], singletons: [] });
        },
      },
      intervalMs: 1000,
      timers: time.timers,
      onError: (error) => errors.push(error),
    });
    await waitFor(() => fired === 1);
    time.advance(1000);
    await waitFor(() => fired === 2 && errors.length === 3);
    time.advance(1000);
    await waitFor(() => fired === 3);
    await loop.stop();
    expect(errors.map((error) => (error as Error).message)).toEqual([
      "schedules down",
      "schedules down",
      "pending down",
      "schedules down",
    ]);
  });

  it("stops scheduling after stop and rejects a non-positive interval", async () => {
    const time = createVirtualTime();
    let passes = 0;
    const loop = startScheduleLoop({
      manager: fakeManager(() => {
        passes += 1;
        return Promise.resolve(emptyReport);
      }),
      intervalMs: 1000,
      timers: time.timers,
    });
    await waitFor(() => passes === 1);
    await loop.stop();
    time.advance(10_000);
    expect(passes).toBe(1);
    expect(() =>
      startScheduleLoop({
        manager: fakeManager(() => Promise.resolve(emptyReport)),
        intervalMs: 0,
      }),
    ).toThrow(RangeError);
  });
});
