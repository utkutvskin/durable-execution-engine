import { describe, expect, it } from "vitest";
import { LeaseLostError, ShutdownTimeoutError } from "./errors.js";
import { createDeferred, createMemoryQueue, createVirtualTime, waitFor } from "./test-support.js";
import { createWorker, type TaskHandler } from "./worker.js";

function setup(handler: TaskHandler, overrides: Partial<Parameters<typeof createWorker>[0]> = {}) {
  const queue = createMemoryQueue();
  const time = createVirtualTime();
  const worker = createWorker({
    queue,
    queueName: "q",
    handler,
    timers: time.timers,
    clock: time.clock,
    visibilityTimeoutMs: 9000,
    heartbeatIntervalMs: 3000,
    ...overrides,
  });
  return { queue, time, worker };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });
}

describe("a failing heartbeat", () => {
  it("keeps the step running while the lease may still be valid", async () => {
    const gate = createDeferred();
    let aborted = false;
    const { queue, time, worker } = setup(async (_task, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await gate.promise;
    });
    queue.extendError = new Error("connection reset");
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);

    time.advance(3000);
    await waitFor(() => queue.extended.length === 1);
    time.advance(3000);
    await waitFor(() => queue.extended.length === 2);

    expect(aborted).toBe(false);
    gate.resolve();
    await worker.stop();
  });

  it("aborts the step once it has failed for a whole visibility timeout", async () => {
    let reason: unknown;
    const { queue, time, worker } = setup(async (_task, { signal }) => {
      await untilAborted(signal);
      reason = signal.reason;
    });
    queue.extendError = new Error("connection reset");
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);

    for (let beat = 1; beat <= 3; beat += 1) {
      time.advance(3000);
      await waitFor(() => queue.extended.length === beat);
    }
    await waitFor(() => worker.activeCount === 0);

    expect(reason).toBeInstanceOf(LeaseLostError);
    expect(queue.acked).toEqual([]);
    expect(queue.nacked).toEqual([]);
    await worker.stop();
  });

  it("forgives failures that end before the visibility timeout", async () => {
    const gate = createDeferred();
    let aborted = false;
    const { queue, time, worker } = setup(async (_task, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await gate.promise;
    });
    queue.extendError = new Error("connection reset");
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);
    time.advance(3000);
    await waitFor(() => queue.extended.length === 1);
    queue.extendError = undefined;
    time.advance(3000);
    await waitFor(() => queue.extended.length === 2);
    queue.extendError = new Error("connection reset");

    time.advance(3000);
    await waitFor(() => queue.extended.length === 3);
    time.advance(3000);
    await waitFor(() => queue.extended.length === 4);

    expect(aborted).toBe(false);
    gate.resolve();
    await worker.stop();
  });
});

describe("a shutdown that drops a step", () => {
  it("aborts the step and nacks only after the handler has settled", async () => {
    const order: string[] = [];
    const { queue, time, worker } = setup(
      async (_task, { signal }) => {
        await untilAborted(signal);
        await Promise.resolve();
        order.push("handler settled");
      },
      { shutdownTimeoutMs: 1000 },
    );
    const nack = queue.nack.bind(queue);
    queue.nack = (taskId, leaseToken, delayMs) => {
      order.push("nack");
      return nack(taskId, leaseToken, delayMs);
    };
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);

    const stopped = worker.stop();
    await waitFor(() => time.pendingDelays().includes(1000));
    time.advance(1000);

    expect(await stopped).toEqual({ completed: 0, dropped: 1 });
    expect(order).toEqual(["handler settled", "nack"]);
  });

  it("carries a ShutdownTimeoutError on the signal the handler sees", async () => {
    let reason: unknown;
    const { time, queue, worker } = setup(
      async (_task, { signal }) => {
        await untilAborted(signal);
        reason = signal.reason;
      },
      { shutdownTimeoutMs: 1000 },
    );
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);

    const stopped = worker.stop();
    await waitFor(() => time.pendingDelays().includes(1000));
    time.advance(1000);
    await stopped;

    expect(reason).toBeInstanceOf(ShutdownTimeoutError);
  });

  it("nacks after the abort grace when the handler ignores the signal", async () => {
    const { queue, time, worker } = setup(() => new Promise<void>(() => undefined), {
      shutdownTimeoutMs: 1000,
      abortGraceMs: 400,
    });
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);

    const stopped = worker.stop();
    await waitFor(() => time.pendingDelays().includes(1000));
    time.advance(1000);
    await waitFor(() => time.pendingDelays().includes(400));
    expect(queue.nacked).toEqual([]);
    time.advance(400);

    expect(await stopped).toEqual({ completed: 0, dropped: 1 });
    expect(queue.nacked).toEqual(["task-1"]);
  });
});
