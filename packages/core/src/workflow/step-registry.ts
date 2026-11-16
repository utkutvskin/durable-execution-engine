/**
 * What a step handler receives besides its input. `signal` aborts when the
 * step must stop: one of its timeouts elapsed, its task lost the lease to
 * another worker, or the worker is shutting down. A step that does I/O
 * should pass it on (for example to `fetch`) so that work stops instead of
 * running twice.
 */
export interface StepContext {
  readonly signal: AbortSignal;
  /**
   * The number of this attempt of the step, starting at 1.
   */
  readonly attempt: number;
  /**
   * The details of the last `heartbeat()` an earlier attempt of this step
   * reported, or `undefined` when none did. A long step resumes from here.
   */
  readonly heartbeatDetails: unknown;
  /**
   * Reports that the step is still making progress. It restarts the step's
   * heartbeat timeout, and `details` (any JSON value) is stored as the
   * step's last progress, which a retried attempt receives as
   * `heartbeatDetails`. Stores are coalesced: while one is in flight only
   * the latest details are kept for the next. A heartbeat after the attempt
   * ended is ignored.
   */
  heartbeat(details?: unknown): void;
}

/**
 * A `StepContext` for a step that runs outside a worker, as tests and the
 * in-memory runner do: attempt 1, no earlier details, a heartbeat that does
 * nothing, and `signal` (by default one that never aborts).
 */
export function detachedStepContext(
  signal: AbortSignal = new AbortController().signal,
): StepContext {
  return {
    signal,
    attempt: 1,
    heartbeatDetails: undefined,
    heartbeat: () => undefined,
  };
}

/**
 * A step's implementation: the side-effecting function a `ctx.step()` call
 * invokes by its registered `stepType`.
 */
export type StepHandler<TInput = unknown, TResult = unknown> = (
  input: TInput,
  context: StepContext,
) => TResult | Promise<TResult>;

/**
 * Looks up step implementations by the `stepType` string workflow code
 * refers to them by. Steps are registered by name rather than passed as
 * closures, so a worker can look one up and run it without having executed
 * the workflow that calls it.
 */
export interface StepRegistry {
  register<TInput, TResult>(stepType: string, handler: StepHandler<TInput, TResult>): void;
  get(stepType: string): StepHandler | undefined;
}

/**
 * Creates an empty, in-memory `StepRegistry`.
 */
export function createStepRegistry(): StepRegistry {
  const handlers = new Map<string, StepHandler>();
  return {
    register<TInput, TResult>(stepType: string, handler: StepHandler<TInput, TResult>): void {
      if (handlers.has(stepType)) {
        throw new Error(`step type "${stepType}" is already registered`);
      }
      handlers.set(stepType, handler as StepHandler);
    },
    get(stepType: string): StepHandler | undefined {
      return handlers.get(stepType);
    },
  };
}
