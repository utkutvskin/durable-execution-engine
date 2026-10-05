import { describe, expect, it } from "vitest";
import type { CatchUpReport, TimerScheduler } from "@dee/core";
import { startTimerLoop } from "./timer-loop.js";
import { createVirtualTime, waitFor } from "./test-support.js";

const emptyReport: CatchUpReport = { fired: [], cancelled: 0, ticks: 1 };

function fakeScheduler(catchUp: TimerScheduler["catchUp"]): TimerScheduler {
  return {
    catchUp,
    clockRegressions: 0,
    schedule: () => Promise.resolve(true),
    tick: () => Promise.resolve({ fired: [], cancelled: 0 }),
    nextDueAt: () => Promise.resolve(undefined),
  };
}

describe("timer loop", () => {
  it("catches up immediately on start, before the first interval elapses", async () => {
    const time = createVirtualTime();
    let passes = 0;
    const loop = startTimerLoop({
      scheduler: fakeScheduler(() => {
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
    const loop = startTimerLoop({
      scheduler: fakeScheduler(() => {
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
    const loop = startTimerLoop({
      scheduler: fakeScheduler(() => {
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

  it("stops scheduling after stop and rejects a non-positive interval", async () => {
    const time = createVirtualTime();
    let passes = 0;
    const loop = startTimerLoop({
      scheduler: fakeScheduler(() => {
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
      startTimerLoop({
        scheduler: fakeScheduler(() => Promise.resolve(emptyReport)),
        intervalMs: 0,
      }),
    ).toThrow(RangeError);
  });
});
