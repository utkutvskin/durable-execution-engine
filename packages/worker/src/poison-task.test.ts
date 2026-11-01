import { describe, expect, it } from "vitest";
import { ParkTaskError } from "./errors.js";
import { createMemoryQueue, createVirtualTime, waitFor } from "./test-support.js";
import { createWorker, nackDelayFor } from "./worker.js";

const failing = (): Promise<void> => Promise.reject(new Error("boom"));

function setup(overrides: Partial<Parameters<typeof createWorker>[0]> = {}) {
  const queue = createMemoryQueue();
  const time = createVirtualTime();
  const worker = createWorker({
    queue,
    queueName: "q",
    handler: failing,
    timers: time.timers,
    ...overrides,
  });
  return { queue, worker };
}

describe("poison task policy", () => {
  it("doubles the delay with each delivery and stops at the maximum", () => {
    const backoff = { initialMs: 100, maxMs: 1000 };
    expect([1, 2, 3, 4, 5, 6].map((attempts) => nackDelayFor(attempts, backoff))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });

  it("does not overflow for a very large attempt count", () => {
    expect(nackDelayFor(10_000, { initialMs: 100, maxMs: 5000 })).toBe(5000);
  });

  it("nacks a failing task with the backoff of its attempt count", async () => {
    const { queue, worker } = setup({ nackBackoff: { initialMs: 100, maxMs: 10_000 } });
    queue.add(1, 3);
    worker.start();
    await waitFor(() => queue.nacked.length === 1);
    expect(queue.nackDelays).toEqual([400]);
    await worker.stop();
  });

  it("keeps the fixed nack delay when no backoff is configured", async () => {
    const { queue, worker } = setup({ nackDelayMs: 75 });
    queue.add(1, 4);
    worker.start();
    await waitFor(() => queue.nacked.length === 1);
    expect(queue.nackDelays).toEqual([75]);
    await worker.stop();
  });

  it("quarantines a task whose handler failed on the maximum delivery", async () => {
    const { queue, worker } = setup({ maxHandlerAttempts: 3 });
    queue.add(1, 3);
    worker.start();
    await waitFor(() => queue.quarantined.length === 1);
    expect(queue.nacked).toEqual([]);
    expect(queue.quarantined[0]?.reason).toBe("handler failed 3 times: boom");
    await worker.stop();
  });

  it("nacks a task that failed fewer times than the maximum", async () => {
    const { queue, worker } = setup({ maxHandlerAttempts: 3 });
    queue.add(1, 2);
    worker.start();
    await waitFor(() => queue.nacked.length === 1);
    expect(queue.quarantined).toEqual([]);
    await worker.stop();
  });

  it("quarantines at once a task whose handler parks it", async () => {
    const { queue, worker } = setup({
      handler: () => Promise.reject(new ParkTaskError("no workflow registered")),
    });
    queue.add(1);
    worker.start();
    await waitFor(() => queue.quarantined.length === 1);
    expect(queue.quarantined[0]).toEqual({ id: "task-1", reason: "no workflow registered" });
    expect(queue.nacked).toEqual([]);
    await worker.stop();
  });

  it("rejects a backoff that is not positive", () => {
    expect(() => setup({ nackBackoff: { initialMs: 0, maxMs: 10 } })).toThrow(RangeError);
    expect(() => setup({ maxHandlerAttempts: 0 })).toThrow(RangeError);
  });
});
