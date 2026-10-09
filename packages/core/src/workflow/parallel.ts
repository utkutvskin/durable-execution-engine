import type { ParallelOptions, ParallelTask } from "./context.js";

/**
 * Picks which running task the parallel loop waits on next, by index.
 * Returning `undefined` means none of them can settle yet. A runner whose
 * tasks settle in real time may answer asynchronously.
 */
export type ChooseNext = (
  running: ReadonlyMap<number, Promise<unknown>>,
) => number | undefined | Promise<number>;

function validateConcurrency(concurrency: number | undefined, taskCount: number): number {
  if (concurrency === undefined) {
    return Math.max(taskCount, 1);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${String(concurrency)}`);
  }
  return concurrency;
}

/**
 * The shared loop behind `ctx.all()` and `ctx.allSettled()`. It starts tasks
 * in index order up to the concurrency limit and, whenever one must be
 * waited for, asks `choose` which one, so a replay can answer from the
 * recorded history and start the same tasks the original execution did.
 */
export async function runParallel<TResult>(
  tasks: readonly ParallelTask<TResult>[],
  options: ParallelOptions | undefined,
  mode: "all" | "allSettled",
  choose: ChooseNext,
): Promise<PromiseSettledResult<TResult>[]> {
  const limit = validateConcurrency(options?.concurrency, tasks.length);
  const outcomes: PromiseSettledResult<TResult>[] = [];
  const running = new Map<number, Promise<TResult>>();
  let next = 0;
  let settled = 0;
  while (settled < tasks.length) {
    while (next < tasks.length && running.size < limit) {
      const task = tasks[next];
      if (task === undefined) {
        break;
      }
      const promise = task();
      promise.catch(() => undefined);
      running.set(next, promise);
      next += 1;
    }
    const chosen = await choose(running);
    if (chosen === undefined) {
      await new Promise<never>(() => undefined);
      return outcomes;
    }
    const promise = running.get(chosen);
    if (promise === undefined) {
      throw new Error(`parallel task ${String(chosen)} is not running`);
    }
    running.delete(chosen);
    try {
      outcomes[chosen] = { status: "fulfilled", value: await promise };
    } catch (reason: unknown) {
      if (mode === "all") {
        throw reason;
      }
      outcomes[chosen] = { status: "rejected", reason };
    }
    settled += 1;
  }
  return outcomes;
}

/**
 * Unwraps the fulfilled values of `outcomes`, which `runParallel` only
 * returns for `all` after every task fulfilled.
 */
export function fulfilledValues<TResult>(
  outcomes: readonly PromiseSettledResult<TResult>[],
): TResult[] {
  return outcomes.map(
    (outcome) => (outcome.status === "fulfilled" ? outcome.value : undefined) as TResult,
  );
}
