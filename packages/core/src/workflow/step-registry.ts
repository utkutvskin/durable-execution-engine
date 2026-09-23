/**
 * A step's implementation: the side-effecting function a `ctx.step()` call
 * invokes by its registered `stepType`.
 */
export type StepHandler<TInput = unknown, TResult = unknown> = (
  input: TInput,
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
