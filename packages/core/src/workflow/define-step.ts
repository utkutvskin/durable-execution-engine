import type { ZodType } from "zod";
import { StepTimeoutError } from "./errors.js";
import type { StepRegistry } from "./step-registry.js";

/**
 * Declares a step: pairs a `stepType` name with its handler and the parts of
 * its contract that are checked at execution time rather than only by the
 * type system. `inputSchema` and `resultSchema` are optional because not
 * every step needs runtime validation on top of its TypeScript types, but
 * when given they are enforced on every call, including one driven by a
 * worker that only has `unknown` off the wire.
 */
export interface DefineStepOptions<TInput, TResult> {
  readonly stepType: string;
  readonly inputSchema?: ZodType<TInput>;
  readonly resultSchema?: ZodType<TResult>;
  readonly timeoutMs?: number;
  readonly handler: (input: TInput) => TResult | Promise<TResult>;
}

/**
 * A step's full execution contract: its name, its timeout, and `execute`,
 * which runs its handler under that contract (input validation, timeout,
 * result validation) rather than calling the handler directly.
 */
export interface StepDefinition<TResult = unknown> {
  readonly stepType: string;
  readonly timeoutMs: number | undefined;
  execute(input: unknown): Promise<TResult>;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function withTimeout<TResult>(
  attempt: Promise<TResult>,
  stepType: string,
  timeoutMs: number,
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new StepTimeoutError(stepType, timeoutMs));
    }, timeoutMs);

    attempt.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(toError(reason));
      },
    );
  });
}

/**
 * Declares a step from `options`. The returned `StepDefinition.execute`
 * parses `input` against `inputSchema` (when given) before calling
 * `handler`, races the handler against `timeoutMs` (when given, rejecting
 * with `StepTimeoutError` if it is not the first to settle), and parses the
 * handler's result against `resultSchema` (when given) before returning it.
 * A validation failure surfaces as the schema's own error (a zod
 * `ZodError`), not a step-specific one: it means the caller or the handler
 * violated the contract, which is a different failure than the handler's
 * own logic rejecting.
 */
export function defineStep<TInput = unknown, TResult = unknown>(
  options: DefineStepOptions<TInput, TResult>,
): StepDefinition<TResult> {
  return {
    stepType: options.stepType,
    timeoutMs: options.timeoutMs,
    async execute(rawInput: unknown): Promise<TResult> {
      const input =
        options.inputSchema === undefined
          ? (rawInput as TInput)
          : options.inputSchema.parse(rawInput);

      const attempt = Promise.resolve().then(() => options.handler(input));
      const result =
        options.timeoutMs === undefined
          ? await attempt
          : await withTimeout(attempt, options.stepType, options.timeoutMs);

      return options.resultSchema === undefined ? result : options.resultSchema.parse(result);
    },
  };
}

/**
 * Registers `definition` with `registry` under its own `stepType`, so a
 * `ctx.step()` call looks it up and runs it through `execute` (schema
 * validation and timeout included) rather than through a bare handler.
 */
export function registerStep<TResult>(
  registry: StepRegistry,
  definition: StepDefinition<TResult>,
): void {
  registry.register<unknown, TResult>(definition.stepType, (input: unknown) =>
    definition.execute(input),
  );
}
