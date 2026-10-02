/**
 * The timer functions a worker schedules its poll waits, heartbeats and
 * shutdown deadline with. Injecting them lets tests move time without
 * waiting.
 */
export interface Timers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * `Timers` backed by the real Node timer functions.
 */
export const systemTimers: Timers = {
  setTimeout(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
