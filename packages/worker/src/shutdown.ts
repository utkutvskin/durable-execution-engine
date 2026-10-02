import type { Worker } from "./worker.js";

/**
 * The slice of Node's `process` that signal handling needs, so tests can
 * stand in for the real one.
 */
export interface ProcessLike {
  on(signal: string, listener: () => void): unknown;
  removeListener(signal: string, listener: () => void): unknown;
  exit(code: number): unknown;
}

/**
 * Makes `worker` stop gracefully on the given signals (default `SIGTERM`
 * and `SIGINT`): no new tasks are taken, running ones finish, and the
 * process exits with code 0. If the worker had to drop tasks at its
 * shutdown timeout the exit code is 1 instead. Returns a function that
 * removes the listeners again.
 */
export function installShutdownHandlers(
  worker: Worker,
  processLike: ProcessLike,
  signals: readonly string[] = ["SIGTERM", "SIGINT"],
): () => void {
  const listener = (): void => {
    void worker.stop().then((result) => processLike.exit(result.dropped === 0 ? 0 : 1));
  };
  for (const signal of signals) {
    processLike.on(signal, listener);
  }
  return (): void => {
    for (const signal of signals) {
      processLike.removeListener(signal, listener);
    }
  };
}
