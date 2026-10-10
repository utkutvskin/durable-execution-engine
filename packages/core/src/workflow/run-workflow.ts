import type { WorkflowCommand } from "./commands.js";
import type {
  ChildHandle,
  ChildOptions,
  ParallelOptions,
  ParallelTask,
  SelectResult,
  WorkflowContext,
  WorkflowHandler,
} from "./context.js";
import { ChildLimitExceededError } from "./errors.js";
import { fulfilledValues, runParallel } from "./parallel.js";
import type { ClockSource, RandomSource } from "./sources.js";
import type { StepRegistry } from "./step-registry.js";
import type { WorkflowRegistry } from "./workflow-registry.js";

/**
 * Everything `runWorkflowInMemory` needs beyond the workflow itself: where
 * to read time and randomness from, and where to look up the step
 * implementations `ctx.step()` calls invoke.
 */
export interface RunWorkflowOptions {
  readonly clock: ClockSource;
  readonly random: RandomSource;
  readonly steps: StepRegistry;
  readonly workflows?: WorkflowRegistry;
  readonly maxChildren?: number;
}

const DEFAULT_MAX_IN_MEMORY_CHILDREN = 1000;

/**
 * The outcome of running a workflow to completion: the full command
 * sequence it produced, plus either the result it resolved with or the
 * error it rejected with.
 */
export type RunWorkflowResult<TResult = unknown> =
  | {
      readonly outcome: "completed";
      readonly result: TResult;
      readonly commands: readonly WorkflowCommand[];
    }
  | {
      readonly outcome: "failed";
      readonly error: Error;
      readonly commands: readonly WorkflowCommand[];
    }
  | {
      readonly outcome: "continued_as_new";
      readonly input: unknown;
      readonly commands: readonly WorkflowCommand[];
    };

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

async function runChildChain(
  handler: WorkflowHandler<never>,
  input: unknown,
  options: RunWorkflowOptions,
): Promise<Exclude<RunWorkflowResult, { outcome: "continued_as_new" }>> {
  let nextInput = input;
  for (;;) {
    const outcome = await runWorkflowInMemory(handler, nextInput as never, options);
    if (outcome.outcome !== "continued_as_new") {
      return outcome;
    }
    nextInput = outcome.input;
  }
}

function createInMemoryContext(
  options: RunWorkflowOptions,
  commands: WorkflowCommand[],
  onContinueAsNew: (input: unknown) => void,
): WorkflowContext {
  let stepSequence = 0;
  let timerSequence = 0;
  let childSequence = 0;
  const maxChildren = options.maxChildren ?? DEFAULT_MAX_IN_MEMORY_CHILDREN;

  function startChild<TResult>(
    workflowType: string,
    input: unknown,
    childOptions?: ChildOptions,
  ): ChildHandle<TResult> {
    childSequence += 1;
    if (childSequence > maxChildren) {
      throw new ChildLimitExceededError(maxChildren);
    }
    const childId = `child-${String(childSequence)}`;
    commands.push({
      type: "start_child",
      childId,
      workflowType,
      input,
      parentClosePolicy: childOptions?.parentClosePolicy ?? "cancel",
    });
    const definition = options.workflows?.get(workflowType);
    const result =
      definition === undefined
        ? Promise.reject<TResult>(new Error(`no workflow registered for type "${workflowType}"`))
        : runChildChain(definition.handler, input, options).then((outcome) => {
            if (outcome.outcome === "failed") {
              throw outcome.error;
            }
            return outcome.result as TResult;
          });
    result.catch(() => undefined);
    return { childId, result };
  }

  function parallel<TResult>(
    tasks: readonly ParallelTask<TResult>[],
    parallelOptions: ParallelOptions | undefined,
    mode: "all" | "allSettled",
  ): Promise<PromiseSettledResult<TResult>[]> {
    return runParallel(tasks, parallelOptions, mode, (running) =>
      Promise.race(
        [...running].map(([index, promise]) =>
          promise.then(
            () => index,
            () => index,
          ),
        ),
      ),
    );
  }

  return {
    startChild,
    executeChild<TResult>(
      workflowType: string,
      input: unknown,
      childOptions?: ChildOptions,
    ): Promise<TResult> {
      return startChild<TResult>(workflowType, input, childOptions).result;
    },
    async all<TResult>(
      tasks: readonly ParallelTask<TResult>[],
      parallelOptions?: ParallelOptions,
    ): Promise<TResult[]> {
      return fulfilledValues(await parallel(tasks, parallelOptions, "all"));
    },
    allSettled<TResult>(
      tasks: readonly ParallelTask<TResult>[],
      parallelOptions?: ParallelOptions,
    ): Promise<PromiseSettledResult<TResult>[]> {
      return parallel(tasks, parallelOptions, "allSettled");
    },
    async step<TResult>(stepType: string, input: unknown): Promise<TResult> {
      stepSequence += 1;
      const stepId = `step-${String(stepSequence)}`;
      commands.push({ type: "schedule_step", stepId, stepType, input });
      const handler = options.steps.get(stepType);
      if (handler === undefined) {
        throw new Error(`no step registered for type "${stepType}"`);
      }
      return (await handler(input)) as TResult;
    },
    sleep(durationMs: number): Promise<void> {
      timerSequence += 1;
      const timerId = `timer-${String(timerSequence)}`;
      const fireAt = new Date(options.clock.now().getTime() + durationMs).toISOString();
      commands.push({ type: "start_timer", timerId, fireAt });
      return Promise.resolve();
    },
    waitForSignal<TPayload>(signalName: string): Promise<TPayload> {
      return Promise.reject(
        new Error(`signal "${signalName}" cannot be awaited by the in-memory runner`),
      );
    },
    async select<TBranches extends readonly Promise<unknown>[]>(
      branches: TBranches,
    ): Promise<SelectResult<Awaited<TBranches[number]>>> {
      const settled = await Promise.race(
        branches.map(async (branch, index) => ({ index, value: await branch })),
      );
      return settled as SelectResult<Awaited<TBranches[number]>>;
    },
    setQueryHandler(): void {
      return undefined;
    },
    onCancel(): void {
      return undefined;
    },
    continueAsNew(input: unknown): Promise<never> {
      onContinueAsNew(input);
      return new Promise<never>(() => undefined);
    },
    now(): Date {
      return options.clock.now();
    },
    random(): number {
      return options.random.random();
    },
    uuid(): string {
      return options.random.uuid();
    },
  };
}

/**
 * Runs `handler` against `input` entirely in memory: every `ctx.step()`
 * call runs its registered step handler immediately and every
 * `ctx.sleep()` call resolves immediately, recording a command for each as
 * it goes. Ends with exactly one `complete_run` command (the handler
 * resolved) or `fail_run` command (the handler rejected, or called
 * `ctx.step()` with an unregistered step type) appended to the sequence,
 * or, when the handler called `ctx.continueAsNew()`, with the single
 * `continue_as_new` command and the `continued_as_new` outcome.
 * There is no suspension or replay yet: that is the decision loop this
 * runner is a foundation for.
 */
export async function runWorkflowInMemory<TInput, TResult>(
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult<TResult>> {
  const commands: WorkflowCommand[] = [];
  let continuation: { readonly input: unknown } | undefined;
  let signalContinuation: () => void = () => undefined;
  const continued = new Promise<void>((resolve) => {
    signalContinuation = resolve;
  });
  const ctx = createInMemoryContext(options, commands, (nextInput) => {
    continuation ??= { input: nextInput };
    signalContinuation();
  });
  try {
    const result = await Promise.race([handler(ctx, input), continued.then(() => undefined)]);
    if (continuation !== undefined) {
      const continueCommand: WorkflowCommand = {
        type: "continue_as_new",
        input: continuation.input,
      };
      return {
        outcome: "continued_as_new",
        input: continuation.input,
        commands: [continueCommand],
      };
    }
    commands.push({ type: "complete_run", result });
    return { outcome: "completed", result: result as TResult, commands };
  } catch (reason) {
    const error = toError(reason);
    commands.push({ type: "fail_run", error: { name: error.name, message: error.message } });
    return { outcome: "failed", error, commands };
  }
}

/**
 * Looks `workflowType` up in `workflows` and runs it against `input` with
 * `runWorkflowInMemory`. Rejects directly, without producing a command,
 * when no workflow is registered under that name: that is a worker
 * configuration error, not a run outcome.
 */
export async function runRegisteredWorkflowInMemory<TResult = unknown>(
  workflowType: string,
  input: unknown,
  options: RunWorkflowOptions & { readonly workflows: WorkflowRegistry },
): Promise<RunWorkflowResult<TResult>> {
  const definition = options.workflows.get(workflowType);
  if (definition === undefined) {
    throw new Error(`no workflow registered for type "${workflowType}"`);
  }
  return runWorkflowInMemory(
    definition.handler as WorkflowHandler<unknown, TResult>,
    input,
    options,
  );
}
