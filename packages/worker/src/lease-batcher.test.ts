import { describe, expect, it } from "vitest";
import type { LeaseRef, TaskQueue } from "@dee/core";
import { createLeaseBatcher } from "./lease-batcher.ts";

interface RecordingQueue extends TaskQueue {
  readonly ackBatches: (readonly LeaseRef[])[];
  readonly extendBatches: (readonly LeaseRef[])[];
  readonly singleAcks: string[];
}

function recordingQueue(options: { batched: boolean; failing?: Error }): RecordingQueue {
  const ackBatches: (readonly LeaseRef[])[] = [];
  const extendBatches: (readonly LeaseRef[])[] = [];
  const singleAcks: string[] = [];
  const current = (lease: LeaseRef): boolean => !lease.leaseToken.startsWith("stale");
  const base: RecordingQueue = {
    ackBatches,
    extendBatches,
    singleAcks,
    enqueue: () => Promise.reject(new Error("not used")),
    dequeue: () => Promise.resolve([]),
    ack: (taskId, leaseToken) => {
      singleAcks.push(taskId);
      return Promise.resolve(current({ taskId, leaseToken }));
    },
    nack: () => Promise.resolve(true),
    quarantine: () => Promise.resolve(true),
    extend: () => Promise.resolve(true),
  };
  if (!options.batched) {
    return base;
  }
  return {
    ...base,
    ackMany: (leases) => {
      ackBatches.push(leases);
      return options.failing === undefined
        ? Promise.resolve(leases.map(current))
        : Promise.reject(options.failing);
    },
    extendMany: (leases) => {
      extendBatches.push(leases);
      return Promise.resolve(leases.map(current));
    },
  };
}

function lease(index: number, prefix = "lease"): LeaseRef {
  return { taskId: `task-${String(index)}`, leaseToken: `${prefix}-${String(index)}` };
}

describe("lease batcher", () => {
  it("sends the acks of one turn as one batch and answers each lease on its own", async () => {
    const queue = recordingQueue({ batched: true });
    const batcher = createLeaseBatcher(queue, 30_000);

    const results = await Promise.all([
      batcher.ack(lease(1)),
      batcher.ack(lease(2, "stale")),
      batcher.ack(lease(3)),
      batcher.ack(lease(4)),
      batcher.ack(lease(5)),
    ]);

    expect(queue.ackBatches).toHaveLength(1);
    expect(queue.ackBatches[0]?.map((entry) => entry.taskId)).toEqual([
      "task-1",
      "task-2",
      "task-3",
      "task-4",
      "task-5",
    ]);
    expect(results).toEqual([true, false, true, true, true]);
    expect(queue.singleAcks).toEqual([]);
  });

  it("starts a new batch for requests made after the previous one was sent", async () => {
    const queue = recordingQueue({ batched: true });
    const batcher = createLeaseBatcher(queue, 30_000);

    await Promise.all([batcher.extend(lease(1)), batcher.extend(lease(2))]);
    await batcher.extend(lease(3));

    expect(queue.extendBatches.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it("falls back to one call per lease for a queue without batch methods", async () => {
    const queue = recordingQueue({ batched: false });
    const batcher = createLeaseBatcher(queue, 30_000);

    const results = await Promise.all([batcher.ack(lease(1)), batcher.ack(lease(2, "stale"))]);

    expect(queue.singleAcks).toEqual(["task-1", "task-2"]);
    expect(results).toEqual([true, false]);
  });

  it("rejects every request of a batch that fails", async () => {
    const failure = new Error("connection lost");
    const queue = recordingQueue({ batched: true, failing: failure });
    const batcher = createLeaseBatcher(queue, 30_000);

    const results = await Promise.allSettled([batcher.ack(lease(1)), batcher.ack(lease(2))]);

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
  });
});
