import type { RecordedError, WorkflowEvent } from "../event-store/events.ts";
import { deserializeError, toRecordedError } from "./error-serialization.ts";
import { UnknownUpdateError, type UpdateDefinition } from "./define-update.ts";
import type { CarriedSignal, WorkflowCommand } from "./commands.ts";
import type {
  ChildHandle,
  ChildOptions,
  CompensationHandler,
  ParallelOptions,
  ParallelTask,
  QueryHandler,
  SelectResult,
  WaitForEventOptions,
  WorkflowContext,
  WorkflowHandler,
} from "./context.ts";
import {
  CancelledError,
  ChildLimitExceededError,
  EventWaitTimeoutError,
  NonDeterminismError,
  StepFailedError,
  VersionMismatchError,
  sleepDurationError,
} from "./errors.ts";
import { createCommandMatcher, recordedCommandOf } from "./command-matcher.ts";
import { createContextValues } from "./context-values.ts";
import { fulfilledValues, runParallel } from "./parallel.ts";
import {
  ForbiddenApiError,
  guardAgainstForbiddenApis,
  runUnguarded,
  waitForMacrotask,
  WorkflowActiveAfterQuiescenceError,
} from "./sandbox.ts";
import type { ClockSource, RandomSource } from "./sources.ts";

/**
 * Everything `runDecisionLoop` needs beyond the workflow itself and its
 * recorded history: where to read time and randomness from. There is no
 * `StepRegistry` here, unlike `runWorkflowInMemory` — the decision loop
 * never executes a step's side-effecting body, it only ever reads a
 * completed step's result back out of the history it was given.
 */
export interface DecisionLoopOptions {
  readonly clock: ClockSource;
  /**
   * Overrides the generator behind `ctx.random()` and `ctx.uuid()`. Left
   * out, they come from a generator seeded by `runId` and a per-run
   * counter, which replays the same values on every decision.
   */
  readonly random?: RandomSource;
  /** The run the decision belongs to; seeds `ctx.random()` and `ctx.uuid()`. */
  readonly runId?: string;
  /**
   * When the event that triggered the decision was written. `ctx.now()`
   * answers with it for a call that has no recorded time yet; `clock` is the
   * fallback.
   */
  readonly triggeredAt?: Date;
  readonly maxChildren?: number;
  readonly historyWarningThreshold?: number;
  readonly buildId?: string;
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

/**
 * Normalizes anything a handler rejected with into an `Error`.
 */
export function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Rebuilds the `Error` a recorded `step_failed` or `child_failed` event stands for.
 */
export function reconstructError(error: RecordedError): Error {
  return deserializeError(error);
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
export function drainToQuiescence(): Promise<void> {
  return waitForMacrotask();
}

/**
 * Whether `error` means the decision itself cannot be trusted
 * (`NonDeterminismError`, `ForbiddenApiError`, `WorkflowActiveAfterQuiescenceError`,
 * `VersionMismatchError`) rather than the workflow failing.
 */
export function isIntegrityError(error: unknown): error is Error {
  return (
    error instanceof NonDeterminismError ||
    error instanceof ForbiddenApiError ||
    error instanceof WorkflowActiveAfterQuiescenceError ||
    error instanceof VersionMismatchError
  );
}

function neverSettles<TValue>(): Promise<TValue> {
  return new Promise<TValue>(() => undefined);
}

/**
 * The handlers a workflow registered by the point its replay stopped,
 * keyed by name.
 */
export interface RegisteredHandlers {
  readonly queries: Map<string, QueryHandler>;
  readonly updates: Map<string, UpdateDefinition>;
}

function createReplayContext(
  history: readonly WorkflowEvent[],
  options: DecisionLoopOptions,
  newCommands: WorkflowCommand[],
  handlers: RegisteredHandlers,
  integrity: { error?: Error },
  compensations: CompensationHandler[],
  inFlightSteps: Set<string>,
  continuation: { requested?: { readonly input: unknown } },
  consultedPatches: Set<string>,
): {
  readonly workflowContext: WorkflowContext;
  readonly compensationContext: WorkflowContext;
  readonly feedHistory: () => Promise<void>;
  readonly assertAllCommandsIssued: () => void;
  readonly unconsumedSignals: () => CarriedSignal[];
} {
  const cancelRequested = history.some((event) => event.type === "cancel_requested");
  let stepSequence = 0;
  let timerSequence = 0;
  let childSequence = 0;
  let waitSequence = 0;
  const pendingConditions: {
    readonly predicate: () => boolean;
    readonly settle: (outcome: { readonly met: boolean } | { readonly error: unknown }) => void;
  }[] = [];
  const maxChildren = options.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const cancelledPromises = new WeakSet<Promise<unknown>>();
  const signalSequences = new Map<string, number>();
  const completionPositions = new WeakMap<Promise<unknown>, number>();
  const deliveries = new Map<number, (() => void)[]>();
  let fedUpTo = -1;
  const matcher = createCommandMatcher();
  matcher.record(history.flatMap((event) => recordedCommandOf(event) ?? []));
  const recordedPatchIds = new Set(
    history.flatMap((event) => (event.type === "patch_recorded" ? [event.patchId] : [])),
  );
  const recordedCommandCount = history.filter(
    (event) =>
      event.type === "step_scheduled" ||
      event.type === "timer_started" ||
      event.type === "child_started" ||
      event.type === "event_wait_started",
  ).length;
  const patchDecisions = new Map<string, boolean>();
  const values = createContextValues(
    options,
    history.flatMap((event) => (event.type === "time_recorded" ? [event.time] : [])),
    () => options.triggeredAt,
    (command) => newCommands.push(command),
  );
  const completedUpdates = new Set(
    history.flatMap((event) => (event.type === "update_completed" ? [event.updateId] : [])),
  );

  function applyUpdate(event: Extract<WorkflowEvent, { type: "update_accepted" }>): void {
    const definition = handlers.updates.get(event.updateName);
    const outcome = new Promise<unknown>((resolve) => {
      if (definition === undefined) {
        throw new UnknownUpdateError(event.updateName);
      }
      resolve(definition.handler(event.argument));
    });
    outcome.then(
      (result: unknown) => {
        if (!completedUpdates.has(event.updateId)) {
          newCommands.push({ type: "complete_update", updateId: event.updateId, result });
        }
      },
      (reason: unknown) => {
        if (isIntegrityError(reason)) {
          integrity.error ??= reason;
        } else if (!completedUpdates.has(event.updateId)) {
          newCommands.push({
            type: "complete_update",
            updateId: event.updateId,
            result: null,
            error: toRecordedError(reason),
          });
        }
      },
    );
  }

  for (const [historyIndex, event] of history.entries()) {
    if (event.type === "update_accepted") {
      deliveries.set(historyIndex, [
        () => {
          applyUpdate(event);
        },
      ]);
    }
  }

  function decidePatch(patchId: string): boolean {
    consultedPatches.add(patchId);
    const decided = patchDecisions.get(patchId);
    if (decided !== undefined) {
      return decided;
    }
    let useNewPath: boolean;
    if (recordedPatchIds.has(patchId)) {
      matcher.issue({ kind: "patch", id: patchId });
      useNewPath = true;
    } else if (stepSequence + timerSequence + childSequence + waitSequence < recordedCommandCount) {
      useNewPath = false;
    } else {
      matcher.issue({ kind: "patch", id: patchId });
      useNewPath = true;
      newCommands.push(
        options.buildId === undefined
          ? { type: "record_patch", patchId }
          : { type: "record_patch", patchId, buildId: options.buildId },
      );
    }
    patchDecisions.set(patchId, useNewPath);
    return useNewPath;
  }

  function completedAt<TValue>(
    historyIndex: number,
    outcome:
      | { readonly fulfilled: true; readonly value: TValue }
      | { readonly fulfilled: false; readonly error: Error },
  ): Promise<TValue> {
    const promise = new Promise<TValue>((resolve, reject) => {
      const release = (): void => {
        if (outcome.fulfilled) {
          resolve(outcome.value);
        } else {
          reject(outcome.error);
        }
      };
      if (historyIndex <= fedUpTo) {
        release();
        return;
      }
      const queued = deliveries.get(historyIndex);
      if (queued === undefined) {
        deliveries.set(historyIndex, [release]);
      } else {
        queued.push(release);
      }
    });
    promise.catch(() => undefined);
    completionPositions.set(promise, historyIndex);
    return promise;
  }

  function checkConditions(): boolean {
    let settledAny = false;
    for (const pending of [...pendingConditions]) {
      let outcome: { readonly met: boolean } | { readonly error: unknown };
      try {
        outcome = { met: pending.predicate() };
      } catch (error: unknown) {
        outcome = { error };
      }
      if ("error" in outcome || outcome.met) {
        pendingConditions.splice(pendingConditions.indexOf(pending), 1);
        pending.settle(outcome);
        settledAny = true;
      }
    }
    return settledAny;
  }

  async function settleConditions(): Promise<void> {
    while (checkConditions()) {
      await drainToQuiescence();
    }
  }

  function unconsumedSignals(): CarriedSignal[] {
    const seen = new Map<string, number>();
    const carried: CarriedSignal[] = [];
    for (const event of history) {
      if (event.type !== "signal_received") {
        continue;
      }
      const position = seen.get(event.signalName) ?? 0;
      seen.set(event.signalName, position + 1);
      if (position >= (signalSequences.get(event.signalName) ?? 0)) {
        carried.push(
          event.signalId === undefined
            ? { signalName: event.signalName, payload: event.payload }
            : { signalName: event.signalName, payload: event.payload, signalId: event.signalId },
        );
      }
    }
    return carried;
  }

  async function feedHistory(): Promise<void> {
    await settleConditions();
    for (;;) {
      let next: number | undefined;
      for (const index of deliveries.keys()) {
        if (next === undefined || index < next) {
          next = index;
        }
      }
      if (next === undefined) {
        return;
      }
      fedUpTo = next;
      const releases = deliveries.get(next) ?? [];
      deliveries.delete(next);
      for (const release of releases) {
        release();
      }
      await drainToQuiescence();
      await settleConditions();
    }
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

      const recorded = matcher.issue(
        { kind: "child", id: childId, workflowType, input },
        cancelled,
      );
      if (!recorded) {
        if (cancelled) {
          throw new CancelledError();
        }
        newCommands.push({
          type: "start_child",
          childId,
          workflowType,
          input,
          parentClosePolicy,
          ...(childOptions?.runTimeoutMs === undefined
            ? {}
            : { runTimeoutMs: childOptions.runTimeoutMs }),
          ...(childOptions?.executionTimeoutMs === undefined
            ? {}
            : { executionTimeoutMs: childOptions.executionTimeoutMs }),
        });
      }

      const finishedIndex = history.findIndex(
        (event) =>
          (event.type === "child_completed" || event.type === "child_failed") &&
          event.childId === childId,
      );
      const finished = history[finishedIndex];
      let result: Promise<TResult>;
      if (finished?.type === "child_completed") {
        result = completedAt(finishedIndex, { fulfilled: true, value: finished.result as TResult });
      } else if (finished?.type === "child_failed") {
        result = completedAt(finishedIndex, {
          fulfilled: false,
          error: reconstructError(finished.error),
        });
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

    function sleep(durationMs: number): Promise<void> {
      const invalid = sleepDurationError(durationMs);
      if (invalid !== undefined) {
        return Promise.reject(invalid);
      }
      timerSequence += 1;
      const timerId = `timer-${String(timerSequence)}`;
      const recorded = matcher.issue({ kind: "timer", id: timerId, durationMs }, cancelled);

      const firedIndex = history.findIndex(
        (event) => event.type === "timer_fired" && event.timerId === timerId,
      );
      if (firedIndex >= 0) {
        return completedAt(firedIndex, { fulfilled: true, value: undefined });
      }

      if (cancelled) {
        return Promise.reject(new CancelledError());
      }

      if (!recorded) {
        const fireAt = new Date(
          runUnguarded(() => options.clock.now()).getTime() + durationMs,
        ).toISOString();
        newCommands.push({ type: "start_timer", timerId, fireAt, durationMs });
      }

      return neverSettles();
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

        const recorded = matcher.issue({ kind: "step", id: stepId, stepType, input }, cancelled);

        const finishedIndex = history.findIndex(
          (event) =>
            (event.type === "step_completed" || event.type === "step_failed") &&
            event.stepId === stepId,
        );
        const finished = history[finishedIndex];
        if (finished?.type === "step_completed") {
          return completedAt(finishedIndex, {
            fulfilled: true,
            value: finished.result as TResult,
          });
        }
        if (finished?.type === "step_failed") {
          return completedAt(finishedIndex, {
            fulfilled: false,
            error:
              finished.exhausted === true
                ? new StepFailedError(stepId, stepType, reconstructError(finished.error))
                : reconstructError(finished.error),
          });
        }

        if (!recorded) {
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
      sleep,
      waitForEvent<TPayload>(
        eventName: string,
        waitOptions: WaitForEventOptions,
      ): Promise<TPayload> {
        const { match: key, timeoutMs } = waitOptions;
        if (timeoutMs !== undefined) {
          const invalid = sleepDurationError(timeoutMs);
          if (invalid !== undefined) {
            return Promise.reject(invalid);
          }
        }
        waitSequence += 1;
        const waitId = `wait-${String(waitSequence)}`;
        const recorded = matcher.issue(
          { kind: "event_wait", id: waitId, eventName, key },
          cancelled,
        );
        if (!recorded && !cancelled) {
          const expiresAt =
            timeoutMs === undefined
              ? undefined
              : new Date(
                  runUnguarded(() => options.clock.now()).getTime() + timeoutMs,
                ).toISOString();
          newCommands.push(
            expiresAt === undefined
              ? { type: "wait_for_event", waitId, eventName, key }
              : { type: "wait_for_event", waitId, eventName, key, expiresAt },
          );
        }
        const timer = timeoutMs === undefined ? undefined : sleep(timeoutMs);
        timer?.catch(() => undefined);
        const timerId = `timer-${String(timerSequence)}`;
        const receivedIndex = history.findIndex(
          (event) => event.type === "event_received" && event.waitId === waitId,
        );
        const firedIndex =
          timer === undefined
            ? -1
            : history.findIndex(
                (event) => event.type === "timer_fired" && event.timerId === timerId,
              );
        const received = history[receivedIndex];
        if (received?.type === "event_received" && (firedIndex < 0 || receivedIndex < firedIndex)) {
          return completedAt(receivedIndex, {
            fulfilled: true,
            value: received.payload as TPayload,
          });
        }
        if (firedIndex >= 0) {
          return completedAt<TPayload>(firedIndex, {
            fulfilled: false,
            error: new EventWaitTimeoutError(eventName, key, timeoutMs ?? 0),
          });
        }
        if (cancelled) {
          return rejectedByCancellation<TPayload>();
        }
        return neverSettles<TPayload>();
      },
      condition(predicate: () => boolean, timeoutMs?: number): Promise<boolean> {
        if (timeoutMs !== undefined) {
          const invalid = sleepDurationError(timeoutMs);
          if (invalid !== undefined) {
            return Promise.reject(invalid);
          }
        }
        if (predicate()) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve, reject) => {
          const entry = {
            predicate,
            settle: (outcome: { readonly met: boolean } | { readonly error: unknown }): void => {
              if ("error" in outcome) {
                reject(toError(outcome.error));
              } else {
                resolve(outcome.met);
              }
            },
          };
          pendingConditions.push(entry);
          if (timeoutMs === undefined) {
            return;
          }
          sleep(timeoutMs).then(
            () => {
              const position = pendingConditions.indexOf(entry);
              if (position >= 0) {
                pendingConditions.splice(position, 1);
                resolve(false);
              }
            },
            (reason: unknown) => {
              const position = pendingConditions.indexOf(entry);
              if (position >= 0) {
                pendingConditions.splice(position, 1);
                reject(toError(reason));
              }
            },
          );
        });
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
          return completedAt(deliveredIndex, {
            fulfilled: true,
            value: delivered.payload as TPayload,
          });
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
        handlers.queries.set(queryName, handler);
      },
      setUpdateHandler<TArgument, TResult>(definition: UpdateDefinition<TArgument, TResult>): void {
        handlers.updates.set(definition.updateName, definition as UpdateDefinition);
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
      patched(patchId: string): boolean {
        return decidePatch(patchId);
      },
      deprecatePatch(patchId: string): void {
        decidePatch(patchId);
      },
      now: values.now,
      random: values.random,
      uuid: values.uuid,
    };
  }

  return {
    workflowContext: buildContext(true),
    compensationContext: buildContext(false),
    feedHistory,
    assertAllCommandsIssued: () => {
      matcher.assertAllIssued();
    },
    unconsumedSignals,
  };
}

/**
 * The state a replay stopped in: how the handler settled (`undefined` when
 * it is still waiting), the commands it newly discovered, and the query
 * and update handlers it had registered by then.
 */
export interface ReplayOutcome<TResult> {
  readonly settled:
    | { readonly outcome: "completed"; readonly result: TResult }
    | { readonly outcome: "failed"; readonly error: Error }
    | undefined;
  readonly commands: WorkflowCommand[];
  readonly queryHandlers: ReadonlyMap<string, QueryHandler>;
  readonly updateHandlers: ReadonlyMap<string, UpdateDefinition>;
  readonly continuation:
    { readonly input: unknown; readonly signals: readonly CarriedSignal[] } | undefined;
  readonly unconsultedPatches: readonly string[];
  readonly unissuedCommand: Error | undefined;
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
  const handlers: RegisteredHandlers = { queries: new Map(), updates: new Map() };
  const integrity: { error?: Error } = {};
  const compensations: CompensationHandler[] = [];
  const inFlightSteps = new Set<string>();
  const continuation: { requested?: { readonly input: unknown } } = {};
  const consultedPatches = new Set<string>();
  const {
    workflowContext,
    compensationContext,
    feedHistory,
    assertAllCommandsIssued,
    unconsumedSignals,
  } = createReplayContext(
    history,
    options,
    commands,
    handlers,
    integrity,
    compensations,
    inFlightSteps,
    continuation,
    consultedPatches,
  );
  const cancelEvent = history.find(
    (event): event is Extract<WorkflowEvent, { type: "cancel_requested" }> =>
      event.type === "cancel_requested",
  );
  let settled: ReplayOutcome<TResult>["settled"];
  let handlerDone = false;
  let compensated = false;

  const recordedCompensationFailures = new Set(
    history.flatMap((event) => (event.type === "compensation_failed" ? [event.index] : [])),
  );

  async function runCompensations(): Promise<void> {
    for (let index = compensations.length - 1; index >= 0; index -= 1) {
      const compensation = compensations[index];
      if (compensation === undefined) {
        continue;
      }
      try {
        await compensation(compensationContext);
      } catch (reason: unknown) {
        if (isIntegrityError(reason)) {
          settled = { outcome: "failed", error: reason };
        } else if (!recordedCompensationFailures.has(index)) {
          commands.push({
            type: "record_compensation_failure",
            index,
            error: toRecordedError(reason),
          });
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
    await feedHistory();

    if (cancelEvent !== undefined && (handlerDone || inFlightSteps.size === 0)) {
      void runCompensations();
      await drainToQuiescence();
      await feedHistory();
    }
  });

  if (integrity.error !== undefined) {
    settled = { outcome: "failed", error: integrity.error };
  }

  let unissuedCommand: Error | undefined;
  try {
    assertAllCommandsIssued();
  } catch (reason: unknown) {
    unissuedCommand = toError(reason);
  }

  const unconsultedPatches = [
    ...new Set(
      history.flatMap((event) =>
        event.type === "patch_recorded" && !consultedPatches.has(event.patchId)
          ? [event.patchId]
          : [],
      ),
    ),
  ];
  const continued =
    continuation.requested === undefined
      ? undefined
      : { input: continuation.requested.input, signals: unconsumedSignals() };
  if (cancelEvent === undefined) {
    return {
      settled,
      commands,
      queryHandlers: handlers.queries,
      updateHandlers: handlers.updates,
      continuation: continued,
      unconsultedPatches,
      unissuedCommand,
      cancellation: { requested: false },
    };
  }
  return {
    settled,
    commands,
    queryHandlers: handlers.queries,
    updateHandlers: handlers.updates,
    continuation: continued,
    unconsultedPatches,
    unissuedCommand,
    cancellation: {
      requested: true,
      ...(cancelEvent.reason === undefined ? {} : { reason: cancelEvent.reason }),
      compensated,
    },
  };
}

/**
 * Refuses a decision whose history holds patches the replaying code never
 * asked about, naming the builds that recorded them.
 */
export function throwOnVersionMismatch(
  history: readonly WorkflowEvent[],
  unconsultedPatches: readonly string[],
  options: DecisionLoopOptions,
): void {
  if (unconsultedPatches.length === 0) {
    return;
  }
  const recordedBy = new Set<string>();
  for (const event of history) {
    if (
      event.type === "patch_recorded" &&
      event.buildId !== undefined &&
      unconsultedPatches.includes(event.patchId)
    ) {
      recordedBy.add(event.buildId);
    }
  }
  throw new VersionMismatchError(unconsultedPatches, [...recordedBy], options.buildId);
}

async function decide<TInput, TResult>(
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  history: readonly WorkflowEvent[],
  options: DecisionLoopOptions,
): Promise<DecisionResult<TResult>> {
  const { settled, commands, cancellation, continuation, unconsultedPatches, unissuedCommand } =
    await replayHistory(handler, input, history, options);
  throwOnVersionMismatch(history, unconsultedPatches, options);
  if (settled?.outcome === "failed" && isIntegrityError(settled.error)) {
    throw settled.error;
  }
  if (unissuedCommand !== undefined) {
    throw unissuedCommand;
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
      commands: [
        continuation.signals.length === 0
          ? { type: "continue_as_new", input: continuation.input }
          : { type: "continue_as_new", input: continuation.input, signals: continuation.signals },
      ],
    };
  }
  if (settled === undefined) {
    return { outcome: "suspended", commands };
  }
  if (settled.outcome === "completed") {
    commands.push({ type: "complete_run", result: settled.result });
    return { outcome: "completed", result: settled.result, commands };
  }
  commands.push({ type: "fail_run", error: toRecordedError(settled.error) });
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
