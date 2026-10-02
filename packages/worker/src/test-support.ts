import type { DequeueOptions, EnqueueInput, LeasedTask, TaskQueue } from "@dee/core";
import type { Timers } from "./timers.js";

export interface VirtualTime {
  readonly timers: Timers;
  readonly clock: { now(): Date };
  advance(ms: number): void;
  pendingDelays(): number[];
}

export function createVirtualTime(start = new Date("2026-01-01T00:00:00.000Z")): VirtualTime {
  let elapsed = 0;
  let nextId = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();

  return {
    timers: {
      setTimeout(callback: () => void, delayMs: number): unknown {
        nextId += 1;
        scheduled.set(nextId, { at: elapsed + delayMs, callback });
        return nextId;
      },
      clearTimeout(handle: unknown): void {
        scheduled.delete(handle as number);
      },
    },
    clock: { now: () => new Date(start.getTime() + elapsed) },
    advance(ms: number): void {
      const target = elapsed + ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (due === undefined) {
          break;
        }
        scheduled.delete(due[0]);
        elapsed = Math.max(elapsed, due[1].at);
        due[1].callback();
      }
      elapsed = target;
    },
    pendingDelays(): number[] {
      return [...scheduled.values()].map((entry) => entry.at - elapsed);
    },
  };
}

export async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("condition was not met in time");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export interface MemoryQueue extends TaskQueue {
  readonly acked: string[];
  readonly nacked: string[];
  readonly extended: string[];
  readonly dequeueLimits: number[];
  extendResult: boolean;
  dequeueError: Error | undefined;
  add(count: number): void;
}

export function createMemoryQueue(): MemoryQueue {
  let sequence = 0;
  const pending: LeasedTask[] = [];
  const queue: MemoryQueue = {
    acked: [],
    nacked: [],
    extended: [],
    dequeueLimits: [],
    extendResult: true,
    dequeueError: undefined,
    add(count: number): void {
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        pending.push({
          id: `task-${String(sequence)}`,
          namespaceId: "ns",
          runId: "run",
          queueName: "q",
          taskType: "STEP_TASK",
          payload: {},
          attempts: 1,
          leaseToken: `lease-${String(sequence)}`,
          visibleAt: new Date(0),
        });
      }
    },
    enqueue(_input: EnqueueInput): Promise<string> {
      return Promise.reject(new Error("not supported by the memory queue"));
    },
    dequeue(options: DequeueOptions): Promise<LeasedTask[]> {
      queue.dequeueLimits.push(options.limit ?? 1);
      if (queue.dequeueError !== undefined) {
        return Promise.reject(queue.dequeueError);
      }
      return Promise.resolve(pending.splice(0, options.limit ?? 1));
    },
    ack(taskId: string): Promise<boolean> {
      queue.acked.push(taskId);
      return Promise.resolve(true);
    },
    nack(taskId: string): Promise<boolean> {
      queue.nacked.push(taskId);
      return Promise.resolve(true);
    },
    extend(taskId: string): Promise<boolean> {
      queue.extended.push(taskId);
      return Promise.resolve(queue.extendResult);
    },
  };
  return queue;
}

export function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
