import { describe, expect, it } from "vitest";
import { LeaseLostError, ShutdownTimeoutError } from "./errors.js";
import { createDeferred, createMemoryQueue, createVirtualTime, waitFor } from "./test-support.js";
import { createWorker, type TaskHandler } from "./worker.js";

const noop: TaskHandler = () => Promise.resolve();

function setup(overrides: Partial<Parameters<typeof createWorker>[0]> = {}) {
  const queue = createMemoryQueue();
  const time = createVirtualTime();
  const worker = createWorker({
    queue,
    queueName: "q",
    handler: noop,
    timers: time.timers,
    ...overrides,
  });
  return { queue, time, worker };
}

describe("worker poll loop", () => {
  it("acks a task whose handler resolves", async () => {
    const { queue, worker } = setup();
    queue.add(1);
    worker.start();
    await waitFor(() => queue.acked.length === 1);
    expect(queue.acked).toEqual(["task-1"]);
    expect(queue.nacked).toEqual([]);
    await worker.stop();
  });

  it("nacks a task whose handler throws and keeps polling", async () => {
    const errors: unknown[] = [];
    const { queue, worker } = setup({
      handler: (task) =>
        task.id === "task-1" ? Promise.reject(new Error("boom")) : Promise.resolve(),
      onError: (error) => errors.push(error),
    });
    queue.add(2);
    worker.start();
    await waitFor(() => queue.acked.length === 1 && queue.nacked.length === 1);
    expect(queue.nacked).toEqual(["task-1"]);
    expect(queue.acked).toEqual(["task-2"]);
    expect(errors).toHaveLength(1);
    await worker.stop();
  });

  it("never runs more tasks at once than the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => createDeferred());
    let started = 0;
    const { queue, worker } = setup({
      concurrency: 2,
      handler: async () => {
        const gate = gates[started];
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        await gate?.promise;
        active -= 1;
      },
    });
    queue.add(6);
    worker.start();
    await waitFor(() => started === 2);
    expect(worker.activeCount).toBe(2);
    for (const gate of gates) {
      gate.resolve();
    }
    await waitFor(() => queue.acked.length === 6);
    expect(peak).toBe(2);
    expect(queue.dequeueLimits[0]).toBe(2);
    await worker.stop();
  });

  it("waits with exponential backoff on an empty queue and resets once work arrives", async () => {
    const { queue, time, worker } = setup({ pollIntervalMs: 100, maxPollIntervalMs: 400 });
    worker.start();
    const seen: number[] = [];
    for (let poll = 1; poll <= 5; poll += 1) {
      await waitFor(() => queue.dequeueLimits.length === poll && time.pendingDelays().length > 0);
      const delays = time.pendingDelays();
      seen.push(delays[0] ?? -1);
      time.advance(delays[0] ?? 0);
    }
    expect(seen).toEqual([100, 200, 400, 400, 400]);

    queue.add(1);
    await waitFor(() => queue.acked.length === 1);
    await waitFor(() => time.pendingDelays().includes(100));
    await worker.stop();
  });

  it("survives a failing dequeue and reports it", async () => {
    const errors: unknown[] = [];
    const { queue, time, worker } = setup({ pollIntervalMs: 50, onError: (e) => errors.push(e) });
    queue.dequeueError = new Error("connection lost");
    worker.start();
    await waitFor(() => errors.length === 1);
    queue.dequeueError = undefined;
    queue.add(1);
    await waitFor(() => time.pendingDelays().length > 0);
    time.advance(50);
    await waitFor(() => queue.acked.length === 1);
    await worker.stop();
  });

  it("rejects invalid options", () => {
    const queue = createMemoryQueue();
    const base = { queue, queueName: "q", handler: noop };
    expect(() => createWorker({ ...base, concurrency: 0 })).toThrow(RangeError);
    expect(() => createWorker({ ...base, pollIntervalMs: 1.5 })).toThrow(RangeError);
    expect(() =>
      createWorker({ ...base, visibilityTimeoutMs: 1000, heartbeatIntervalMs: 1000 }),
    ).toThrow(/shorter than visibilityTimeoutMs/);
    expect(() => createWorker({ ...base, pollIntervalMs: 500, maxPollIntervalMs: 100 })).toThrow(
      RangeError,
    );
  });

  it("refuses to start twice", async () => {
    const { worker } = setup();
    worker.start();
    expect(() => {
      worker.start();
    }).toThrow(/already started/);
    await worker.stop();
  });
});

describe("worker heartbeat", () => {
  it("renews the lease of a running task at the heartbeat interval", async () => {
    const gate = createDeferred();
    const { queue, time, worker } = setup({
      visibilityTimeoutMs: 9000,
      heartbeatIntervalMs: 3000,
      handler: () => gate.promise,
    });
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);
    for (let beat = 1; beat <= 4; beat += 1) {
      time.advance(3000);
      await waitFor(() => queue.extended.length === beat);
    }
    gate.resolve();
    await waitFor(() => queue.acked.length === 1);
    time.advance(30_000);
    expect(queue.extended).toHaveLength(4);
    await worker.stop();
  });

  it("aborts the task and skips the ack when the lease is lost", async () => {
    const started = createDeferred();
    const gate = createDeferred();
    let reason: unknown;
    const { queue, time, worker } = setup({
      visibilityTimeoutMs: 9000,
      heartbeatIntervalMs: 3000,
      handler: async (_task, { signal }) => {
        started.resolve();
        await gate.promise;
        reason = signal.reason;
      },
    });
    queue.extendResult = false;
    queue.add(1);
    worker.start();
    await started.promise;
    time.advance(3000);
    await waitFor(() => queue.extended.length === 1);
    gate.resolve();
    await waitFor(() => worker.activeCount === 0);
    expect(reason).toBeInstanceOf(LeaseLostError);
    expect(queue.acked).toEqual([]);
    expect(queue.nacked).toEqual([]);
    await worker.stop();
  });
});

describe("worker graceful shutdown", () => {
  it("takes no new tasks after stop and lets the running one finish", async () => {
    const gate = createDeferred();
    const { queue, worker } = setup({ handler: () => gate.promise });
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);
    const stopped = worker.stop();
    queue.add(1);
    gate.resolve();
    expect(await stopped).toEqual({ completed: 1, dropped: 0 });
    expect(queue.acked).toEqual(["task-1"]);
    expect(queue.dequeueLimits).toHaveLength(1);
  });

  it("drops a task that outlives the shutdown timeout, aborting and nacking it", async () => {
    const started = createDeferred();
    let reason: unknown;
    const { queue, time, worker } = setup({
      shutdownTimeoutMs: 5000,
      handler: (_task, { signal }) =>
        new Promise<void>((resolve) => {
          started.resolve();
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            resolve();
          });
        }),
    });
    queue.add(1);
    worker.start();
    await started.promise;
    const stopped = worker.stop();
    await waitFor(() => time.pendingDelays().includes(5000));
    time.advance(5000);
    expect(await stopped).toEqual({ completed: 0, dropped: 1 });
    expect(reason).toBeInstanceOf(ShutdownTimeoutError);
    expect(queue.nacked).toEqual(["task-1"]);
    expect(queue.acked).toEqual([]);
  });

  it("returns the same result when stop is called twice", async () => {
    const { worker } = setup();
    worker.start();
    const first = worker.stop();
    expect(worker.stop()).toBe(first);
    expect(await first).toEqual({ completed: 0, dropped: 0 });
  });
});
