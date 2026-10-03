import { describe, expect, it } from "vitest";
import { createWorkerIdentity } from "./identity.js";
import { createWorker } from "./worker.js";
import { createMemoryQueue, createVirtualTime, waitFor } from "./test-support.js";
import type { DequeueOptions } from "@dee/core";

describe("worker identity", () => {
  it("builds the id from host, pid and suffix", () => {
    const identity = createWorkerIdentity({
      version: "1.2.3",
      host: "box",
      pid: 42,
      suffix: "abcd1234",
    });
    expect(identity).toEqual({ id: "box-42-abcd1234", version: "1.2.3" });
  });

  it("gives two identities in the same process different ids", () => {
    const first = createWorkerIdentity({ version: "1.0.0" });
    const second = createWorkerIdentity({ version: "1.0.0" });
    expect(first.id).not.toBe(second.id);
    expect(first.id).toContain(String(process.pid));
  });

  it("rejects an empty version", () => {
    expect(() => createWorkerIdentity({ version: "" })).toThrow(RangeError);
  });

  it("stamps its identity on every dequeue", async () => {
    const queue = createMemoryQueue();
    const seen: DequeueOptions[] = [];
    const original = queue.dequeue.bind(queue);
    queue.dequeue = (options) => {
      seen.push(options);
      return original(options);
    };
    queue.add(1);
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => Promise.resolve(),
      timers: createVirtualTime().timers,
      identity: { id: "worker-7", version: "3.1.0" },
    });
    worker.start();
    await waitFor(() => queue.acked.length === 1);
    await worker.stop();
    expect(seen[0]).toMatchObject({ workerId: "worker-7", workerVersion: "3.1.0" });
  });

  it("leaves the stamp out when the worker has no identity", async () => {
    const queue = createMemoryQueue();
    const seen: DequeueOptions[] = [];
    const original = queue.dequeue.bind(queue);
    queue.dequeue = (options) => {
      seen.push(options);
      return original(options);
    };
    const worker = createWorker({
      queue,
      queueName: "q",
      handler: () => Promise.resolve(),
      timers: createVirtualTime().timers,
    });
    worker.start();
    await waitFor(() => seen.length > 0);
    await worker.stop();
    expect(seen[0]).not.toHaveProperty("workerId");
  });
});
