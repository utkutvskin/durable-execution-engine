import { isDeepStrictEqual } from "node:util";
import type { WorkflowEvent } from "../event-store/events.js";
import type { WorkflowCommand } from "./commands.js";
import type { WorkflowContext, WorkflowHandler } from "./context.js";
import { NonDeterminismError } from "./errors.js";
import { ForbiddenApiError, guardAgainstForbiddenApis } from "./sandbox.js";
import type { ClockSource, RandomSource } from "./sources.js";

/**
 * Everything `runDecisionLoop` needs beyond the workflow itself and its
 * recorded history: where to read time and randomness from. There is no
 * `StepRegistry` here, unlike `runWorkflowInMemory` — the decision loop
 * never executes a step's side-effecting body, it only ever reads a
 * completed step's result back out of the history it was given.
 */
export interface DecisionLoopOptions {
  readonly clock: ClockSource;
  readonly random: RandomSource;
}

/**
 * The outcome of one decision: replaying `handler` against a history either
 * runs it to completion (`completed` / `failed`, exactly as
 * `runWorkflowInMemory` reports it), or the replay reaches a step or timer
 * the history has no result for yet and stops there (`suspended`). In every
 * case `commands` holds only the commands this decision newly discovered —
 * anything already implied by the given history is never repeated.
 */
export type DecisionResult<TResult = unknown> =
  | { readonly outcome: "completed"; readonly result: TResult; readonly commands: readonly WorkflowCommand[] }
  | { readonly outcome: "failed"; readonly error: Error; readonly commands: readonly WorkflowCommand[] }
  | { readonly outcome: "suspended"; readonly commands: readonly WorkflowCommand[] };

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function reconstructError(error: { readonly name: string; readonly message: string }): Error {
  const reconstructed = new Error(error.message);
  reconstructed.name = error.name;
  return reconstructed;
}

/**
 * Waits for a single Node.js macrotask boundary. Node performs a full
 * microtask checkpoint — draining not just the microtasks queued so far but
 * every microtask those in turn queue, to a fixed point — before running
 * the next macrotask, so one `setImmediate` tick is enough to let a promise
 * chain built entirely from already-settled promises run to wherever it
 * settles or stalls. A step or timer with no recorded result yet is served
 * a promise that is never resolved or rejected, so it schedules nothing:
 * there is no callback left behind for a later tick to leak.
 */
function drainToQuiescence(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function neverSettles<TValue>(): Promise<TValue> {
  return new Promise<TValue>(() => undefined);
}

function findEvent<TEvent extends WorkflowEvent>(
  history: readonly WorkflowEvent[],
  predicate: (event: WorkflowEvent) => event is TEvent,
): TEvent | undefined {
  return history.find(predicate);
}

function createReplayContext(
  history: readonly WorkflowEvent[],
  options: DecisionLoopOptions,
  newCommands: WorkflowCommand[],
): WorkflowContext {
  let stepSequence = 0;
  let timerSequence = 0;

  return {
    step<TResult>(stepType: string, input: unknown): Promise<TResult> {
      stepSequence += 1;
      const stepId = `step-${String(stepSequence)}`;

      const scheduled = findEvent(
        history,
        (event): event is Extract<WorkflowEvent, { type: "step_scheduled" }> =>
          event.type === "step_scheduled" && event.stepId === stepId,
      );
      if (
        scheduled !== undefined &&
        (scheduled.stepType !== stepType || !isDeepStrictEqual(scheduled.input, input))
      ) {
        throw new NonDeterminismError(
          stepId,
          { stepType: scheduled.stepType, input: scheduled.input },
          { stepType, input },
        );
      }

      const completed = findEvent(
        history,
        (event): event is Extract<WorkflowEvent, { type: "step_completed" }> =>
          event.type === "step_completed" && event.stepId === stepId,
      );
      if (completed !== undefined) {
        return Promise.resolve(completed.result as TResult);
      }

      const failed = findEvent(
        history,
        (event): event is Extract<WorkflowEvent, { type: "step_failed" }> =>
          event.type === "step_failed" && event.stepId === stepId,
      );
      if (failed !== undefined) {
        return Promise.reject(reconstructError(failed.error));
      }

      if (scheduled === undefined) {
        newCommands.push({ type: "schedule_step", stepId, stepType, input });
      }

      return neverSettles<TResult>();
    },
    sleep(durationMs: number): Promise<void> {
      timerSequence += 1;
      const timerId = `timer-${String(timerSequence)}`;

      const fired = history.some((event) => event.type === "timer_fired" && event.timerId === timerId);
      if (fired) {
        return Promise.resolve();
      }

      const alreadyStarted = history.some(
        (event) => event.type === "timer_started" && event.timerId === timerId,
      );
      if (!alreadyStarted) {
        const fireAt = new Date(options.clock.now().getTime() + durationMs).toISOString();
        newCommands.push({ type: "start_timer", timerId, fireAt });
      }

      return neverSettles();
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
 * Rebuilds a workflow's decision from its recorded history: runs `handler`
 * from the start, serving every already-recorded step and timer its result
 * straight out of `history` instead of executing it, and stops the moment
 * it reaches one that has none yet. No step handler is ever invoked here —
 * that is a worker's job when it acts on a `schedule_step` command, not the
 * decision loop's.
 *
 * Because replay always starts the handler over from the top and walks the
 * exact same `ctx.step()` / `ctx.sleep()` call sequence, feeding it the
 * same history twice produces the same decision twice: this is what makes
 * the workflow function itself the single source of truth for a run's
 * control flow, with the history only ever supplying results, never
 * control-flow branches.
 *
 * The handler runs with `Date.now`, `Math.random` and `setTimeout` guarded
 * (see `guardAgainstForbiddenApis`): a workflow that calls one of them
 * directly, instead of `ctx.now()` / `ctx.random()` / `ctx.sleep()`, fails
 * with a `ForbiddenApiError`. A `ctx.step()` call whose `stepType` or
 * `input` disagrees with the `step_scheduled` event history already
 * recorded for that `stepId` fails with a `NonDeterminismError`. Both are
 * engine-integrity failures rather than ordinary workflow failures, so
 * `runDecisionLoop` rethrows them instead of reporting them as a
 * `fail_run` outcome.
 */
export async function runDecisionLoop<TInput, TResult>(
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  history: readonly WorkflowEvent[],
  options: DecisionLoopOptions,
): Promise<DecisionResult<TResult>> {
  const commands: WorkflowCommand[] = [];
  const ctx = createReplayContext(history, options, commands);

  let settled:
    | { readonly outcome: "completed"; readonly result: TResult }
    | { readonly outcome: "failed"; readonly error: Error }
    | undefined;

  await guardAgainstForbiddenApis(async () => {
    handler(ctx, input).then(
      (result) => {
        settled = { outcome: "completed", result };
      },
      (reason: unknown) => {
        settled = { outcome: "failed", error: toError(reason) };
      },
    );

    await drainToQuiescence();
  });

  if (settled === undefined) {
    return { outcome: "suspended", commands };
  }
  if (
    settled.outcome === "failed" &&
    (settled.error instanceof NonDeterminismError || settled.error instanceof ForbiddenApiError)
  ) {
    throw settled.error;
  }
  if (settled.outcome === "completed") {
    commands.push({ type: "complete_run", result: settled.result });
    return { outcome: "completed", result: settled.result, commands };
  }
  commands.push({ type: "fail_run", error: { name: settled.error.name, message: settled.error.message } });
  return { outcome: "failed", error: settled.error, commands };
}
