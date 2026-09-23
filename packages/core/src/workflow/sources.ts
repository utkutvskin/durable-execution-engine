/**
 * Supplies the current time to a workflow. Injected so `ctx.now()` never
 * calls `Date.now()` directly, keeping workflow code replay-deterministic:
 * a worker can substitute a fixed clock when replaying an old history.
 */
export interface ClockSource {
  now(): Date;
}

/**
 * Supplies randomness to a workflow. Injected so `ctx.random()` and
 * `ctx.uuid()` never call `Math.random()` or `crypto.randomUUID()`
 * directly, keeping workflow code replay-deterministic.
 */
export interface RandomSource {
  random(): number;
  uuid(): string;
}

/**
 * The `ClockSource` a worker uses outside of replay: real wall-clock time.
 */
export const systemClock: ClockSource = {
  now: (): Date => new Date(),
};

/**
 * The `RandomSource` a worker uses outside of replay: `Math.random()` and
 * `crypto.randomUUID()`.
 */
export const systemRandomSource: RandomSource = {
  random: (): number => Math.random(),
  uuid: (): string => crypto.randomUUID(),
};
