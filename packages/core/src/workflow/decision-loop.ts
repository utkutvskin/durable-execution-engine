import { isDeepStrictEqual } from "node:util";
import type { WorkflowEvent } from "../event-store/events.js";
import type { WorkflowCommand } from "./commands.js";
import type {
  ChildHandle,
  ChildOptions,
  CompensationHandler,
  ParallelOptions,
  ParallelTask,
  QueryHandler,
  SelectResult,
  WorkflowContext,
  WorkflowHandler,
} from "./context.js";
import { CancelledError, ChildLimitExceededError, NonDeterminismError } from "./errors.js";
import { fulfilledValues, runParallel } from "./parallel.js";
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
  readonly maxChildren?: number;
  readonly historyWarningThreshold?: number;
}

/**
 * Attached to a decision whose history has reached the configured
 * `historyWarningThreshold`: a signal that the run should continue as new
 * before its history grows further.
 */
export interface HistoryWarning {
  readonly eventCount: number;
  readonly threshold: number;
}

/**
 * How many child workflows one run may start when `DecisionLoopOptions`
 * does not say otherwise.
 */
export const DEFAULT_MAX_CHILDREN = 1000;

/**
 * The outcome of one decision: replaying `handler` against a history either
 * runs it to completion (`completed` / `failed`, exactly as
 * `runWorkflowInMemory` reports it), or the replay reaches a step or timer
 * the history has no result for yet and stops there (`suspended`). In every
 * case `commands` holds only the commands this decision newly discovered —
 * anything already implied by the given history is never repeated. Once the
 * history holds a `cancel_requested` event the decision is `cancelled` after
 * every compensation has finished and `suspended` until then. A workflow that
 * called `ctx.continueAsNew()` ends as `continued_as_new` with a single
 * `continue_as_new` command. `historyWarning` is present once the history
 * holds at least `historyWarningThreshold` events.
 */
export type DecisionResult<TResult = unknown> = (
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
  | { readonly outcome: "suspended"; readonly commands: readonly WorkflowCommand[] }
  | { readonly outcome: "cancelled"; readonly commands: readonly WorkflowCommand[] }
  | {
      readonly outcome: "continued_as_new";
      readonly input: unknown;
      readonly commands: readonly WorkflowCommand[];
    }
) & { readonly historyWarning?: HistoryWarning };

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

function isIntegrityError(error: unknown): error is Error {
  return error instanceof NonDeterminismError || error instanceof ForbiddenApiError;
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
  queryHandlers: Map<string, QueryHandler>,
  compensations: CompensationHandler[],
  inFlightSteps: Set<string>,
  continuation: { requested?: { readonly input: unknown } },
): { readonly workflowContext: WorkflowContext; readonly compensationContext: WorkflowContext } {
  const cancelRequested = history.some((event) => event.type === "cancel_requested");
  let stepSequence = 0;
  let timerSequence = 0;
  let childSequence = 0;
  const maxChildren = options.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const cancelledPromises = new WeakSet<Promise<unknown>>();
  const signalSequences = new Map<string, number>();
  const completionPositions = new WeakMap<Promise<unknown>, number>();

  function completedAt<TValue>(promise: Promise<TValue>, historyIndex: number): Promise<TValue> {
    completionPositions.set(promise, historyIndex);
    return promise;
  }

  function rejectedByCancellation<TValue>(): Promise<TValue> {
    const rejected = Promise.reject<TValue>(new CancelledError());
    rejected.catch(() => undefined);
    cancelledPromises.add(rejected);
    return rejected;
  }

  function chooseNext(running: ReadonlyMap<number, Promise<unknown>>): number | undefined {
    let winner: number | undefined;
    let winnerPosition = Number.POSITIVE_INFINITY;
    for (const [index, promise] of running) {
      const position = completionPositions.get(promise);
      if (position !== undefined && position < winnerPosition) {
        winner = index;
        winnerPosition = position;
      }
    }
    if (winner !== undefined) {
      return winner;
    }
    for (const [index, promise] of running) {
      if (cancelledPromises.has(promise)) {
        return index;
      }
    }
    return undefined;
  }

  function buildContext(rejectAfterCancel: boolean): WorkflowContext {
    const cancelled = rejectAfterCancel && cancelRequested;

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
      const parentClosePolicy = childOptions?.parentClosePolicy ?? "cancel";

      const started = findEvent(
        history,
        (event): event is Extract<WorkflowEvent, { type: "child_started" }> =>
          event.type === "child_started" && event.childId === childId,
      );
      if (
        started !== undefined &&
        (started.workflowType !== workflowType || !isDeepStrictEqual(started.input, input))
      ) {
        throw new NonDeterminismError(
          childId,
          { stepType: started.workflowType, input: started.input },
          { stepType: workflowType, input },
        );
      }
      if (started === undefined) {
        if (cancelled) {
          throw new CancelledError();
        }
        newCommands.push({ type: "start_child", childId, workflowType, input, parentClosePolicy });
      }

      const finishedIndex = history.findIndex(
        (event) =>
          (event.type === "child_completed" || event.type === "child_failed") &&
          event.childId === childId,
      );
      const finished = history[finishedIndex];
      let result: Promise<TResult>;
      if (finished?.type === "child_completed") {
        result = completedAt(Promise.resolve(finished.result as TResult), finishedIndex);
      } else if (finished?.type === "child_failed") {
        result = completedAt(Promise.reject(reconstructError(finished.error)), finishedIndex);
        result.catch(() => undefined);
      } else if (cancelled) {
        result = rejectedByCancellation<TResult>();
      } else {
        result = neverSettles<TResult>();
      }
      return { childId, result };
    }

    function parallel<TResult>(
      tasks: readonly ParallelTask<TResult>[],
      parallelOptions: ParallelOptions | undefined,
      mode: "all" | "allSettled",
    ): Promise<PromiseSettledResult<TResult>[]> {
      return runParallel(tasks, parallelOptions, mode, chooseNext);
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

        const finishedIndex = history.findIndex(
          (event) =>
            (event.type === "step_completed" || event.type === "step_failed") &&
            event.stepId === stepId,
        );
        const finished = history[finishedIndex];
        if (finished?.type === "step_completed") {
          return completedAt(Promise.resolve(finished.result as TResult), finishedIndex);
        }
        if (finished?.type === "step_failed") {
          return completedAt(Promise.reject(reconstructError(finished.error)), finishedIndex);
        }

        if (scheduled === undefined) {
          if (cancelled) {
            return Promise.reject(new CancelledError());
          }
          newCommands.push({ type: "schedule_step", stepId, stepType, input });
        }

        if (cancelled) {
          inFlightSteps.add(stepId);
        }
        return neverSettles<TResult>();
      },
      sleep(durationMs: number): Promise<void> {
        timerSequence += 1;
        const timerId = `timer-${String(timerSequence)}`;

        const firedIndex = history.findIndex(
          (event) => event.type === "timer_fired" && event.timerId === timerId,
        );
        if (firedIndex >= 0) {
          return completedAt(Promise.resolve(), firedIndex);
        }

        if (cancelled) {
          return Promise.reject(new CancelledError());
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
      waitForSignal<TPayload>(signalName: string): Promise<TPayload> {
        const consumed = signalSequences.get(signalName) ?? 0;
        signalSequences.set(signalName, consumed + 1);

        let seen = 0;
        const deliveredIndex = history.findIndex((event) => {
          if (event.type !== "signal_received" || event.signalName !== signalName) {
            return false;
          }
          seen += 1;
          return seen === consumed + 1;
        });
        const delivered = history[deliveredIndex];
        if (delivered?.type === "signal_received") {
          return completedAt(Promise.resolve(delivered.payload as TPayload), deliveredIndex);
        }
        if (cancelled) {
          return Promise.reject(new CancelledError());
        }
        return neverSettles<TPayload>();
      },
      select<TBranches extends readonly Promise<unknown>[]>(
        branches: TBranches,
      ): Promise<SelectResult<Awaited<TBranches[number]>>> {
        for (const branch of branches) {
          branch.catch(() => undefined);
        }
        let winner = -1;
        let winnerPosition = Number.POSITIVE_INFINITY;
        for (const [index, branch] of branches.entries()) {
          const position = completionPositions.get(branch);
          if (position !== undefined && position < winnerPosition) {
            winner = index;
            winnerPosition = position;
          }
        }
        const chosen = branches[winner];
        if (chosen === undefined) {
          return neverSettles();
        }
        return chosen.then(
          (value) => ({ index: winner, value }) as SelectResult<Awaited<TBranches[number]>>,
        );
      },
      setQueryHandler(queryName: string, handler: QueryHandler): void {
        queryHandlers.set(queryName, handler);
      },
      onCancel(handler: CompensationHandler): void {
        compensations.push(handler);
      },
      continueAsNew(input: unknown): Promise<never> {
        if (cancelRequested) {
          return Promise.reject(new CancelledError());
        }
        continuation.requested ??= { input };
        return neverSettles<never>();
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

  return { workflowContext: buildContext(true), compensationContext: buildContext(false) };
}

/**
 * The state a replay stopped in: how the handler settled (`undefined` when
 * it is still waiting), the commands it newly discovered, and the query
 * handlers it had registered by then.
 */
export interface ReplayOutcome<TResult> {
  readonly settled:
    | { readonly outcome: "completed"; readonly result: TResult }
    | { readonly outcome: "failed"; readonly error: Error }
    | undefined;
  readonly commands: WorkflowCommand[];
  readonly queryHandlers: ReadonlyMap<string, QueryHandler>;
  readonly continuation: { readonly input: unknown } | undefined;
  readonly cancellation:
    | { readonly requested: false }
    | { readonly requested: true; readonly reason?: string; readonly compensated: boolean };
}

/**
 * Replays `handler` over `history` under the forbidden API guard and
 * reports where it stopped, without turning the stop into a decision. Both
 * `runDecisionLoop` and `runQuery` are built on it.
 */
export async function replayHistory<TInput, TResult>(
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  history: readonly WorkflowEvent[],
  options: DecisionLoopOptions,
): Promise<ReplayOutcome<TResult>> {
  const commands: WorkflowCommand[] = [];
  const queryHandlers = new Map<string, QueryHandler>();
  const compensations: CompensationHandler[] = [];
  const inFlightSteps = new Set<string>();
  const continuation: { requested?: { readonly input: unknown } } = {};
  const { workflowContext, compensationContext } = createReplayContext(
    history,
    options,
    commands,
    queryHandlers,
    compensations,
    inFlightSteps,
    continuation,
  );
  const cancelEvent = history.find(
    (event): event is Extract<WorkflowEvent, { type: "cancel_requested" }> =>
      event.type === "cancel_requested",
  );
  let settled: ReplayOutcome<TResult>["settled"];
  let handlerDone = false;
  let compensated = false;

  async function runCompensations(): Promise<void> {
    for (const compensation of [...compensations].reverse()) {
      try {
        await compensation(compensationContext);
      } catch (reason: unknown) {
        if (isIntegrityError(reason)) {
          settled = { outcome: "failed", error: reason };
        }
      }
    }
    compensated = true;
  }

  await guardAgainstForbiddenApis(async () => {
    void handler(workflowContext, input)
      .then(
        (result) => {
          settled = { outcome: "completed", result };
        },
        (reason: unknown) => {
          settled = { outcome: "failed", error: toError(reason) };
        },
      )
      .then(() => {
        handlerDone = true;
      });

    await drainToQuiescence();

    if (cancelEvent !== undefined && (handlerDone || inFlightSteps.size === 0)) {
      void runCompensations();
      await drainToQuiescence();
    }
  });

  if (cancelEvent === undefined) {
    return {
      settled,
      commands,
      queryHandlers,
      continuation: continuation.requested,
      cancellation: { requested: false },
    };
  }
  return {
    settled,
    commands,
    queryHandlers,
    continuation: continuation.requested,
    cancellation: {
      requested: true,
      ...(cancelEvent.reason === undefined ? {} : { reason: cancelEvent.reason }),
      compensated,
    },
  };
}

async function decide<TInput, TResult>(
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  history: readonly WorkflowEvent[],
  options: DecisionLoopOptions,
): Promise<DecisionResult<TResult>> {
  const { settled, commands, cancellation, continuation } = await replayHistory(
    handler,
    input,
    history,
    options,
  );
  if (settled?.outcome === "failed" && isIntegrityError(settled.error)) {
    throw settled.error;
  }
  if (cancellation.requested) {
    if (!cancellation.compensated) {
      return { outcome: "suspended", commands };
    }
    commands.push(
      cancellation.reason === undefined
        ? { type: "cancel_run" }
        : { type: "cancel_run", reason: cancellation.reason },
    );
    return { outcome: "cancelled", commands };
  }
  if (continuation !== undefined) {
    return {
      outcome: "continued_as_new",
      input: continuation.input,
      commands: [{ type: "continue_as_new", input: continuation.input }],
    };
  }
  if (settled === undefined) {
    return { outcome: "suspended", commands };
  }
  if (settled.outcome === "completed") {
    commands.push({ type: "complete_run", result: settled.result });
    return { outcome: "completed", result: settled.result, commands };
  }
  commands.push({
    type: "fail_run",
    error: { name: settled.error.name, message: settled.error.message },
  });
  return { outcome: "failed", error: settled.error, commands };
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
  const decision = await decide(handler, input, history, options);
  const threshold = options.historyWarningThreshold;
  if (threshold === undefined || history.length < threshold) {
    return decision;
  }
  return { ...decision, historyWarning: { eventCount: history.length, threshold } };
}
