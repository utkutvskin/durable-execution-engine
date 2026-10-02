import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installShutdownHandlers, type ProcessLike } from "./shutdown.js";
import { createDeferred, createMemoryQueue, createVirtualTime, waitFor } from "./test-support.js";
import { createWorker } from "./worker.js";

function fakeProcess(): ProcessLike & EventEmitter & { codes: number[] } {
  const emitter = new EventEmitter() as ProcessLike & EventEmitter & { codes: number[] };
  emitter.codes = [];
  emitter.exit = (code: number) => emitter.codes.push(code);
  return emitter;
}

describe("shutdown handlers", () => {
  it("lets the running task finish after SIGTERM and then exits with code 0", async () => {
    const gate = createDeferred();
    const queue = createMemoryQueue();
    const time = createVirtualTime();
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => gate.promise,
      timers: time.timers,
    });
    const processLike = fakeProcess();
    installShutdownHandlers(worker, processLike);
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);

    processLike.emit("SIGTERM");
    await waitFor(() => queue.dequeueLimits.length >= 1);
    expect(processLike.codes).toEqual([]);

    gate.resolve();
    await waitFor(() => processLike.codes.length === 1);
    expect(processLike.codes).toEqual([0]);
    expect(queue.acked).toEqual(["task-1"]);
  });

  it("exits with code 1 when the shutdown timeout dropped a task", async () => {
    const queue = createMemoryQueue();
    const time = createVirtualTime();
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => new Promise<void>(() => undefined),
      shutdownTimeoutMs: 1000,
      timers: time.timers,
    });
    const processLike = fakeProcess();
    installShutdownHandlers(worker, processLike);
    queue.add(1);
    worker.start();
    await waitFor(() => worker.activeCount === 1);

    processLike.emit("SIGINT");
    await waitFor(() => time.pendingDelays().includes(1000));
    time.advance(1000);
    await waitFor(() => processLike.codes.length === 1);
    expect(processLike.codes).toEqual([1]);
  });

  it("stops listening once the returned disposer is called", () => {
    const queue = createMemoryQueue();
    const worker = createWorker({ queue, queueName: "q", handler: () => Promise.resolve() });
    const processLike = fakeProcess();
    const dispose = installShutdownHandlers(worker, processLike);
    expect(processLike.listenerCount("SIGTERM")).toBe(1);
    dispose();
    expect(processLike.listenerCount("SIGTERM")).toBe(0);
    expect(processLike.listenerCount("SIGINT")).toBe(0);
  });
});
