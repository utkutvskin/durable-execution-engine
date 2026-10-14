import { describe, expect, it } from "vitest";
import { createDepthBackpressure, pollBudgetForDepth } from "./backpressure.js";
import { createMemoryQueue, createVirtualTime, waitFor } from "./test-support.js";
import { createWorker } from "./worker.js";

const marks = { lowWatermark: 10, highWatermark: 110 };

describe("depth based poll backpressure", () => {
  it("takes nothing from an empty queue", () => {
    expect(pollBudgetForDepth(0, 8, marks)).toBe(0);
  });

  it("takes the minimum batch at or below the low watermark, never more than the depth", () => {
    expect(pollBudgetForDepth(10, 8, marks)).toBe(1);
    expect(pollBudgetForDepth(3, 8, { ...marks, minBatch: 5 })).toBe(3);
  });

  it("takes every free slot at or above the high watermark", () => {
    expect(pollBudgetForDepth(110, 8, marks)).toBe(8);
    expect(pollBudgetForDepth(100_000, 8, marks)).toBe(8);
  });

  it("grows the allowance monotonically between the watermarks", () => {
    const budgets = [10, 30, 60, 90, 110].map((depth) => pollBudgetForDepth(depth, 9, marks));
    expect(budgets).toEqual([...budgets].sort((left, right) => left - right));
    expect(budgets[0]).toBe(1);
    expect(budgets[4]).toBe(9);
  });

  it("rejects watermarks that do not leave a range", () => {
    const readDepth = () => Promise.resolve(1);
    expect(() => createDepthBackpressure({ readDepth, lowWatermark: 5, highWatermark: 5 })).toThrow(
      RangeError,
    );
  });

  it("makes a worker poll in small batches on a shallow queue and skip the poll on an empty one", async () => {
    const queue = createMemoryQueue();
    const time = createVirtualTime();
    let depth = 0;
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => Promise.resolve(),
      timers: time.timers,
      concurrency: 8,
      pollBudget: createDepthBackpressure({ readDepth: () => Promise.resolve(depth), ...marks }),
    });
    worker.start();
    await waitFor(() => time.pendingDelays().length > 0);
    expect(queue.dequeueLimits).toEqual([]);

    depth = 5;
    queue.add(5);
    time.advance(1000);
    await waitFor(() => queue.acked.length === 5);
    expect(queue.dequeueLimits.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    await worker.stop();
  });

  it("drains a deep queue with every free slot", async () => {
    const queue = createMemoryQueue();
    const time = createVirtualTime();
    queue.add(40);
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => Promise.resolve(),
      timers: time.timers,
      concurrency: 8,
      pollBudget: createDepthBackpressure({ readDepth: () => Promise.resolve(500), ...marks }),
    });
    worker.start();
    await waitFor(() => queue.acked.length === 40);
    expect(queue.dequeueLimits[0]).toBe(8);
    await worker.stop();
  });

  it("falls back to all free slots and reports the error when the depth cannot be read", async () => {
    const queue = createMemoryQueue();
    const time = createVirtualTime();
    const errors: unknown[] = [];
    queue.add(3);
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => Promise.resolve(),
      timers: time.timers,
      concurrency: 3,
      pollBudget: () => Promise.reject(new Error("depth unavailable")),
      onError: (error) => errors.push(error),
    });
    worker.start();
    await waitFor(() => queue.acked.length === 3);
    expect(queue.dequeueLimits[0]).toBe(3);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    await worker.stop();
  });
});
