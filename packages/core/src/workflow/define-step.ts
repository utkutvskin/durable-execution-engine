import type { z } from "zod";
import { resolveRetryPolicy, type RetryPolicy } from "../retry/retry-policy.js";
import type { StepHandler } from "./step-registry.js";

/**
 * A step registered under `stepType`: its handler, wrapped with whatever
 * input/output validation `defineStep` was given, plus the metadata a
 * worker needs to run it (currently just `timeoutMs`). Registering
 * `handler` with a `StepRegistry` is enough to get the validation too —
 * the registry itself stays unaware that it ever happened.
 */
export interface StepDefinition<TInput = unknown, TResult = unknown> {
  readonly stepType: string;
  readonly handler: StepHandler<TInput, TResult>;
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
}

/**
 * The options `defineStep` accepts: the step's real implementation, plus
 * everything optional about its contract.
 */
export interface DefineStepOptions<TInput, TResult> {
  readonly handler: StepHandler<TInput, TResult>;
  readonly input?: z.ZodType<TInput>;
  readonly output?: z.ZodType<TResult>;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
}

/**
 * Declares a step: pairs a `stepType` name with its handler, validating
 * the handler's input and output against `options.input` / `options.output`
 * when given (throwing a `ZodError` on a mismatch, before or after the
 * handler runs). `timeoutMs`, when given, must be positive; it is carried
 * on the returned `StepDefinition` for a worker to enforce, `defineStep`
 * itself does not run anything on a timer. `retry`, when given, is filled
 * in from the default policy and validated with `resolveRetryPolicy`.
 */
export function defineStep<TInput = unknown, TResult = unknown>(
  stepType: string,
  options: DefineStepOptions<TInput, TResult>,
): StepDefinition<TInput, TResult> {
  if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
    throw new Error(
      `step "${stepType}" has a non-positive timeoutMs (${String(options.timeoutMs)})`,
    );
  }

  const handler: StepHandler<TInput, TResult> = async (input: TInput): Promise<TResult> => {
    const validatedInput = options.input === undefined ? input : options.input.parse(input);
    const result = await options.handler(validatedInput);
    return options.output === undefined ? result : options.output.parse(result);
  };

  const retry = options.retry === undefined ? undefined : resolveRetryPolicy(options.retry);
  return {
    stepType,
    handler,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(retry === undefined ? {} : { retry }),
  };
}
