import type { LeaseRef, TaskQueue } from "@dee/core";

/**
 * Coalesces the acks and the lease extensions a worker asks for into one
 * statement each per turn of the event loop.
 */
export interface LeaseBatcher {
  /** Acks the lease with the next batch; resolves what `TaskQueue.ack` would. */
  ack(lease: LeaseRef): Promise<boolean>;
  /** Extends the lease with the next batch; resolves what `TaskQueue.extend` would. */
  extend(lease: LeaseRef): Promise<boolean>;
}

interface Waiting {
  readonly lease: LeaseRef;
  resolve(settled: boolean): void;
  reject(error: unknown): void;
}

type Flush = (leases: readonly LeaseRef[]) => Promise<boolean[]>;

function createBatch(flushBatch: Flush): (lease: LeaseRef) => Promise<boolean> {
  let waiting: Waiting[] = [];

  async function flush(): Promise<void> {
    const batch = waiting;
    waiting = [];
    try {
      const settled = await flushBatch(batch.map((entry) => entry.lease));
      batch.forEach((entry, index) => {
        entry.resolve(settled[index] ?? false);
      });
    } catch (error) {
      batch.forEach((entry) => {
        entry.reject(error);
      });
    }
  }

  return (lease) =>
    new Promise<boolean>((resolve, reject) => {
      waiting.push({ lease, resolve, reject });
      if (waiting.length === 1) {
        setImmediate(() => {
          void flush();
        });
      }
    });
}

/**
 * Creates a `LeaseBatcher` over `queue`. Requests made in one turn of the
 * event loop are sent together after it, through `ackMany` and `extendMany`
 * when the queue has them and one call per lease otherwise. A failing batch
 * rejects every request in it.
 */
export function createLeaseBatcher(queue: TaskQueue, visibilityTimeoutMs: number): LeaseBatcher {
  const ackMany: Flush =
    queue.ackMany === undefined
      ? (leases) => Promise.all(leases.map((lease) => queue.ack(lease.taskId, lease.leaseToken)))
      : (leases) => queue.ackMany?.(leases) ?? Promise.resolve([]);
  const extendMany: Flush =
    queue.extendMany === undefined
      ? (leases) =>
          Promise.all(
            leases.map((lease) =>
              queue.extend(lease.taskId, lease.leaseToken, visibilityTimeoutMs),
            ),
          )
      : (leases) => queue.extendMany?.(leases, visibilityTimeoutMs) ?? Promise.resolve([]);
  return {
    ack: createBatch(ackMany),
    extend: createBatch(extendMany),
  };
}
