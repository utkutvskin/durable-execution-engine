import { describe, expect, it } from "vitest";
import type { EventStore, StoredEvent } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import type { ClockSource } from "../workflow/sources.js";
import {
  StepTimeoutError,
  enforceWorkflowTimeout,
  runWithTimeout,
  workflowDeadline,
  type TimeoutTimers,
} from "./timeout.js";

interface PendingTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

function createVirtualTimers(): TimeoutTimers & {
  advance(ms: number): void;
  readonly pending: () => number;
} {
  let now = 0;
  let nextId = 0;
  let timers: PendingTimer[] = [];
  return {
    setTimeout(callback, delayMs) {
      nextId += 1;
      timers.push({ id: nextId, dueAt: now + delayMs, callback });
      return nextId;
    },
    clearTimeout(handle) {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.dueAt <= now);
      timers = timers.filter((timer) => timer.dueAt > now);
      due.forEach((timer) => {
        timer.callback();
      });
    },
    pending: () => timers.length,
  };
}

describe("step timeout", () => {
  it("rejects with StepTimeoutError once the deadline passes", async () => {
    const timers = createVirtualTimers();
    const never = runWithTimeout(() => new Promise<string>(() => undefined), 5000, timers);
    timers.advance(4999);
    timers.advance(1);
    await expect(never).rejects.toBeInstanceOf(StepTimeoutError);
    await expect(never).rejects.toMatchObject({ timeoutMs: 5000 });
  });

  it("aborts the signal handed to the operation at the deadline", async () => {
    const timers = createVirtualTimers();
    let seen: AbortSignal | undefined;
    const pending = runWithTimeout(
      (signal) => {
        seen = signal;
        return new Promise<string>(() => undefined);
      },
      100,
      timers,
    );
    timers.advance(100);
    await pending.catch(() => undefined);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(StepTimeoutError);
  });

  it("returns the result and clears the timer when the operation finishes in time", async () => {
    const timers = createVirtualTimers();
    const result = await runWithTimeout(() => Promise.resolve("done"), 5000, timers);
    expect(result).toBe("done");
    expect(timers.pending()).toBe(0);
  });

  it("clears the timer when the operation throws", async () => {
    const timers = createVirtualTimers();
    await expect(
      runWithTimeout(() => Promise.reject(new Error("boom")), 5000, timers),
    ).rejects.toThrow("boom");
    expect(timers.pending()).toBe(0);
  });

  it("schedules no timer without a timeout", async () => {
    const timers = createVirtualTimers();
    expect(await runWithTimeout(() => 7, undefined, timers)).toBe(7);
    expect(timers.pending()).toBe(0);
  });
});

function createFakeStore(events: readonly WorkflowEvent[], startedAt: Date) {
  const log: StoredEvent[] = events.map((event, index) => ({
    sequenceNumber: index + 1,
    event,
    createdAt: new Date(startedAt.getTime() + index),
  }));
  const appended: WorkflowEvent[] = [];
  const store: EventStore = {
    append(_runId, _expectedSeq, toAppend) {
      appended.push(...toAppend);
      return Promise.resolve([]);
    },
    read: () => Promise.resolve(log),
  };
  return { store, appended };
}

function clockAt(iso: string): ClockSource {
  return { now: () => new Date(iso) };
}

describe("workflow timeout", () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const started: WorkflowEvent = { type: "run_started", workflowType: "w", input: {} };

  it("computes the deadline from the start time", () => {
    expect(workflowDeadline(startedAt, 90_000).toISOString()).toBe("2026-01-01T00:01:30.000Z");
  });

  it("leaves a run alone before its deadline", async () => {
    const { store, appended } = createFakeStore([started], startedAt);
    const outcome = await enforceWorkflowTimeout({
      store,
      runId: "r",
      timeoutMs: 60_000,
      clock: clockAt("2026-01-01T00:00:59.000Z"),
    });
    expect(outcome).toBe("within_deadline");
    expect(appended).toEqual([]);
  });

  it("appends run_timed_out once the deadline has passed", async () => {
    const { store, appended } = createFakeStore([started], startedAt);
    const outcome = await enforceWorkflowTimeout({
      store,
      runId: "r",
      timeoutMs: 60_000,
      clock: clockAt("2026-01-01T00:01:00.000Z"),
    });
    expect(outcome).toBe("timed_out");
    expect(appended).toEqual([{ type: "run_timed_out" }]);
  });

  it("does not time out a run that already finished", async () => {
    const { store, appended } = createFakeStore(
      [started, { type: "run_completed", result: 1 }],
      startedAt,
    );
    const outcome = await enforceWorkflowTimeout({
      store,
      runId: "r",
      timeoutMs: 1,
      clock: clockAt("2027-01-01T00:00:00.000Z"),
    });
    expect(outcome).toBe("closed");
    expect(appended).toEqual([]);
  });
});
