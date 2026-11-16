import type { z } from "zod";
import { resolveRetryPolicy, type RetryPolicy } from "../retry/retry-policy.ts";
import { detachedStepContext, type StepContext, type StepHandler } from "./step-registry.ts";

/**
 * A step registered under `stepType`: its handler, wrapped with whatever
 * input/output validation `defineStep` was given, plus the metadata a
 * worker needs to run it: its timeouts and its retry policy. Registering
 * `handler` with a `StepRegistry` is enough to get the validation too —
 * the registry itself stays unaware that it ever happened. Passed to
 * `ctx.step()` in place of the `stepType` string, it makes the compiler
 * check the input and the result type.
 *
 * `timeoutMs` is the start-to-close timeout of one attempt.
 * `scheduleToCloseTimeoutMs` bounds the whole step, every attempt and
 * every backoff, from the moment it was scheduled. `heartbeatTimeoutMs`
 * fails an attempt that went that long without a heartbeat.
 */
export interface StepDefinition<TInput = unknown, TResult = unknown> {
  readonly stepType: string;
  readonly handler: (input: TInput, context?: StepContext) => TResult | Promise<TResult>;
  readonly timeoutMs?: number;
  readonly scheduleToCloseTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly retry?: RetryPolicy;
}

/**
 * The options `defineStep` accepts: the step's real implementation, plus
 * everything optional about its contract. `startToCloseTimeoutMs` is
 * another name for `timeoutMs`; give one of the two.
 */
export interface DefineStepOptions<TInput, TResult> {
  readonly handler: StepHandler<TInput, TResult>;
  readonly input?: z.ZodType<TInput>;
  readonly output?: z.ZodType<TResult>;
  readonly timeoutMs?: number;
  readonly startToCloseTimeoutMs?: number;
  readonly scheduleToCloseTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
}

function checkPositive(stepType: string, name: string, value: number | undefined): void {
  if (value !== undefined && !(value > 0)) {
    throw new Error(`step "${stepType}" has a non-positive ${name} (${String(value)})`);
  }
}

/**
 * Declares a step: pairs a `stepType` name with its handler, validating
 * the handler's input and output against `options.input` / `options.output`
 * when given (throwing a `ZodError` on a mismatch, before or after the
 * handler runs). Every timeout, when given, must be positive; they are
 * carried on the returned `StepDefinition` for a worker to enforce,
 * `defineStep` itself does not run anything on a timer. `retry`, when
 * given, is filled in from the default policy and validated with
 * `resolveRetryPolicy`.
 */
export function defineStep<TInput = unknown, TResult = unknown>(
  stepType: string,
  options: DefineStepOptions<TInput, TResult>,
): StepDefinition<TInput, TResult> {
  if (options.timeoutMs !== undefined && options.startToCloseTimeoutMs !== undefined) {
    throw new Error(
      `step "${stepType}" gives both timeoutMs and startToCloseTimeoutMs, which are the same timeout`,
    );
  }
  const timeoutMs = options.timeoutMs ?? options.startToCloseTimeoutMs;
  checkPositive(stepType, "timeoutMs", timeoutMs);
  checkPositive(stepType, "scheduleToCloseTimeoutMs", options.scheduleToCloseTimeoutMs);
  checkPositive(stepType, "heartbeatTimeoutMs", options.heartbeatTimeoutMs);

  const handler = async (
    input: TInput,
    context: StepContext = detachedStepContext(),
  ): Promise<TResult> => {
    const validatedInput = options.input === undefined ? input : options.input.parse(input);
    const result = await options.handler(validatedInput, context);
    return options.output === undefined ? result : options.output.parse(result);
  };

  const retry = options.retry === undefined ? undefined : resolveRetryPolicy(options.retry);
  return {
    stepType,
    handler,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(options.scheduleToCloseTimeoutMs === undefined
      ? {}
      : { scheduleToCloseTimeoutMs: options.scheduleToCloseTimeoutMs }),
    ...(options.heartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
    ...(retry === undefined ? {} : { retry }),
  };
}
