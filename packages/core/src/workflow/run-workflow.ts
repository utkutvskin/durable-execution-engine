import type { WorkflowCommand } from "./commands.js";
import type { WorkflowContext, WorkflowHandler } from "./context.js";
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
}

/**
 * The outcome of running a workflow to completion: the full command
 * sequence it produced, plus either the result it resolved with or the
 * error it rejected with.
 */
export type RunWorkflowResult<TResult = unknown> =
  | { readonly outcome: "completed"; readonly result: TResult; readonly commands: readonly WorkflowCommand[] }
  | { readonly outcome: "failed"; readonly error: Error; readonly commands: readonly WorkflowCommand[] };

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function createInMemoryContext(
  options: RunWorkflowOptions,
  commands: WorkflowCommand[],
): WorkflowContext {
  let stepSequence = 0;
  let timerSequence = 0;
  return {
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
 * `ctx.step()` with an unregistered step type) appended to the sequence.
 * There is no suspension or replay yet: that is the decision loop this
 * runner is a foundation for.
 */
export async function runWorkflowInMemory<TInput, TResult>(
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult<TResult>> {
  const commands: WorkflowCommand[] = [];
  const ctx = createInMemoryContext(options, commands);
  try {
    const result = await handler(ctx, input);
    commands.push({ type: "complete_run", result });
    return { outcome: "completed", result, commands };
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
  return runWorkflowInMemory(definition.handler as WorkflowHandler<unknown, TResult>, input, options);
}
