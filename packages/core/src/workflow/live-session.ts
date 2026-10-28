import { isDeepStrictEqual } from "node:util";
import type { WorkflowEvent } from "../event-store/events.js";
import type { WorkflowCommand } from "./commands.js";
import type { QueryHandler, WorkflowContext, WorkflowHandler } from "./context.js";
import {
  drainToQuiescence,
  isIntegrityError,
  reconstructError,
  toError,
  type DecisionLoopOptions,
  type DecisionResult,
} from "./decision-loop.js";
import { sameEncoding } from "./canonical.js";
import { createContextValues } from "./context-values.js";
import { NonDeterminismError } from "./errors.js";
import { guardAgainstForbiddenApis, runUnguarded } from "./sandbox.js";

/**
 * What `LiveSession.advance` reports. `decided` carries the decision for the
 * history seen so far. `unsupported` means the workflow used a feature a live
 * session does not resume (children, parallel helpers, `select`, compensation
 * handlers or `continueAsNew`), or the history holds an event of such a
 * feature; the caller must decide with a full replay instead. `diverged`
 * means the history handed in is not a continuation of what the session has
 * seen, or the session already finished; the caller must drop the session
 * and replay from scratch.
 */
export type LiveAdvance =
  | { readonly status: "decided"; readonly decision: DecisionResult }
  | { readonly status: "unsupported" }
  | { readonly status: "diverged" };

/**
 * A workflow execution kept alive between decisions. The first `advance`
 * replays the whole history; every later one only feeds the events recorded
 * since, resolving the waits that were suspended, so the handler is not run
 * from the top again. Its state is a pure function of the events it has been
 * fed, which is why a stale session that is advanced with a longer history
 * still decides what a full replay would.
 */
export interface LiveSession {
  /** How many history events the session has consumed. */
  readonly eventCount: number;
  /**
   * Feeds `history` (the whole history, oldest first) and decides.
   * `triggeredAt` is when the event that triggered the decision was written;
   * `ctx.now()` answers with it.
   */
  advance(history: readonly WorkflowEvent[], triggeredAt?: Date): Promise<LiveAdvance>;
}

interface Waiter {
  readonly key: string;
  tryResolve(): boolean;
}

function isSupportedEvent(event: WorkflowEvent): boolean {
  switch (event.type) {
    case "run_started":
    case "step_scheduled":
    case "step_completed":
    case "step_failed":
    case "step_attempt_failed":
    case "timer_started":
    case "timer_fired":
    case "signal_received":
    case "time_recorded":
      return true;
    default:
      return false;
  }
}

/**
 * Creates a `LiveSession` for one run of `handler`. See `LiveSession` for the
 * contract; `createStickyDecider` is the intended caller.
 */
export function createLiveSession<TInput, TResult>(
  handler: WorkflowHandler<TInput, TResult>,
  input: TInput,
  options: DecisionLoopOptions,
): LiveSession {
  const history: WorkflowEvent[] = [];
  const scheduledSteps = new Map<string, Extract<WorkflowEvent, { type: "step_scheduled" }>>();
  const finishedSteps = new Map<string, WorkflowEvent>();
  const startedTimers = new Set<string>();
  const firedTimers = new Set<string>();
  const signals = new Map<string, unknown[]>();
  const signalConsumption = new Map<string, number>();
  const waiters = new Map<string, Waiter[]>();
  const queryHandlers = new Map<string, QueryHandler>();
  const recordedTimes: string[] = [];
  let triggeredAt: Date | undefined;
  let commands: WorkflowCommand[] = [];
  let emitted: readonly WorkflowCommand[] = [];
  let stepSequence = 0;
  let timerSequence = 0;
  const flags = { unsupported: false };

  function hasUnsupportedFeature(): boolean {
    return flags.unsupported;
  }
  let started = false;
  let finished = false;
  let settled:
    | { readonly outcome: "completed"; readonly result: TResult }
    | { readonly outcome: "failed"; readonly error: Error }
    | undefined;

  function register(waiter: Waiter): void {
    if (waiter.tryResolve()) {
      return;
    }
    const existing = waiters.get(waiter.key);
    if (existing === undefined) {
      waiters.set(waiter.key, [waiter]);
    } else {
      existing.push(waiter);
    }
  }

  function notify(key: string): void {
    const pending = waiters.get(key);
    if (pending === undefined) {
      return;
    }
    const remaining = pending.filter((waiter) => !waiter.tryResolve());
    if (remaining.length === 0) {
      waiters.delete(key);
    } else {
      waiters.set(key, remaining);
    }
  }

  function ingest(event: WorkflowEvent): void {
    history.push(event);
    switch (event.type) {
      case "step_scheduled":
        scheduledSteps.set(event.stepId, event);
        break;
      case "step_completed":
      case "step_failed":
        finishedSteps.set(event.stepId, event);
        notify(`step:${event.stepId}`);
        break;
      case "timer_started":
        startedTimers.add(event.timerId);
        break;
      case "timer_fired":
        firedTimers.add(event.timerId);
        notify(`timer:${event.timerId}`);
        break;
      case "time_recorded":
        recordedTimes.push(event.time);
        break;
      case "signal_received": {
        const list = signals.get(event.signalName) ?? [];
        list.push(event.payload);
        signals.set(event.signalName, list);
        notify(`signal:${event.signalName}`);
        break;
      }
      default:
        break;
    }
  }

  function pendingPromise<TValue>(
    key: string,
    attempt: (resolve: (value: TValue) => void, reject: (reason: Error) => void) => boolean,
  ): Promise<TValue> {
    return new Promise<TValue>((resolve, reject) => {
      register({ key, tryResolve: () => attempt(resolve, reject) });
    });
  }

  function flagUnsupported<TValue>(): Promise<TValue> {
    flags.unsupported = true;
    return new Promise<TValue>(() => undefined);
  }

  const values = createContextValues(
    options,
    recordedTimes,
    () => triggeredAt,
    (command) => commands.push(command),
  );

  const context: WorkflowContext = {
    startChild: () => {
      flags.unsupported = true;
      return { childId: "", result: new Promise<never>(() => undefined) };
    },
    executeChild: () => flagUnsupported(),
    all: () => flagUnsupported(),
    allSettled: () => flagUnsupported(),
    select: () => flagUnsupported(),
    continueAsNew: () => flagUnsupported(),
    onCancel: () => {
      flags.unsupported = true;
    },
    step<TResult>(stepType: string, stepInput: unknown): Promise<TResult> {
      stepSequence += 1;
      const stepId = `step-${String(stepSequence)}`;
      const scheduled = scheduledSteps.get(stepId);
      if (
        scheduled !== undefined &&
        (scheduled.stepType !== stepType || !sameEncoding(scheduled.input, stepInput))
      ) {
        throw new NonDeterminismError(
          stepId,
          { stepType: scheduled.stepType, input: scheduled.input },
          { stepType, input: stepInput },
        );
      }
      if (scheduled === undefined) {
        commands.push({ type: "schedule_step", stepId, stepType, input: stepInput });
      }
      return pendingPromise<TResult>(`step:${stepId}`, (resolve, reject) => {
        const done = finishedSteps.get(stepId);
        if (done?.type === "step_completed") {
          resolve(done.result as TResult);
          return true;
        }
        if (done?.type === "step_failed") {
          reject(reconstructError(done.error));
          return true;
        }
        return false;
      });
    },
    sleep(durationMs: number): Promise<void> {
      timerSequence += 1;
      const timerId = `timer-${String(timerSequence)}`;
      if (!firedTimers.has(timerId) && !startedTimers.has(timerId)) {
        const fireAt = new Date(
          runUnguarded(() => options.clock.now()).getTime() + durationMs,
        ).toISOString();
        commands.push({ type: "start_timer", timerId, fireAt });
      }
      return pendingPromise<undefined>(`timer:${timerId}`, (resolve) => {
        if (!firedTimers.has(timerId)) {
          return false;
        }
        resolve(undefined);
        return true;
      });
    },
    waitForSignal<TPayload>(signalName: string): Promise<TPayload> {
      const index = signalConsumption.get(signalName) ?? 0;
      signalConsumption.set(signalName, index + 1);
      return pendingPromise<TPayload>(`signal:${signalName}`, (resolve) => {
        const list = signals.get(signalName) ?? [];
        if (index >= list.length) {
          return false;
        }
        resolve(list[index] as TPayload);
        return true;
      });
    },
    setQueryHandler(queryName: string, queryHandler: QueryHandler): void {
      queryHandlers.set(queryName, queryHandler);
    },
    patched: () => {
      flags.unsupported = true;
      return false;
    },
    deprecatePatch: () => {
      flags.unsupported = true;
    },
    now: values.now,
    random: values.random,
    uuid: values.uuid,
  };

  function emittedAreRecorded(slice: readonly WorkflowEvent[]): boolean {
    const emittedTimes = emitted.filter((command) => command.type === "record_time").length;
    const recordedNow = slice.filter((event) => event.type === "time_recorded").length;
    if (recordedNow < emittedTimes) {
      return false;
    }
    return emitted.every((command) => {
      if (command.type === "schedule_step") {
        return slice.some(
          (event) => event.type === "step_scheduled" && event.stepId === command.stepId,
        );
      }
      if (command.type === "start_timer") {
        return slice.some(
          (event) => event.type === "timer_started" && event.timerId === command.timerId,
        );
      }
      return true;
    });
  }

  function buildDecision(): DecisionResult {
    const threshold = options.historyWarningThreshold;
    const warning =
      threshold !== undefined && history.length >= threshold
        ? { historyWarning: { eventCount: history.length, threshold } }
        : {};
    if (settled === undefined) {
      return { outcome: "suspended", commands, ...warning };
    }
    finished = true;
    if (settled.outcome === "completed") {
      commands.push({ type: "complete_run", result: settled.result });
      return { outcome: "completed", result: settled.result, commands, ...warning };
    }
    commands.push({
      type: "fail_run",
      error: { name: settled.error.name, message: settled.error.message },
    });
    return { outcome: "failed", error: settled.error, commands, ...warning };
  }

  return {
    get eventCount(): number {
      return history.length;
    },

    async advance(full: readonly WorkflowEvent[], trigger?: Date): Promise<LiveAdvance> {
      triggeredAt = trigger;
      const seen = history.length;
      if (finished || flags.unsupported || full.length < seen) {
        return { status: "diverged" };
      }
      const last = history[seen - 1];
      if (last !== undefined && !isDeepStrictEqual(full[seen - 1], last)) {
        return { status: "diverged" };
      }
      const slice = full.slice(seen);
      if (!slice.every(isSupportedEvent)) {
        flags.unsupported = true;
        return { status: "unsupported" };
      }
      if (!emittedAreRecorded(slice)) {
        return { status: "diverged" };
      }
      commands = [];

      await guardAgainstForbiddenApis(async () => {
        for (const event of slice) {
          ingest(event);
        }
        if (!started) {
          started = true;
          void handler(context, input).then(
            (result) => {
              settled = { outcome: "completed", result };
            },
            (reason: unknown) => {
              settled = { outcome: "failed", error: toError(reason) };
            },
          );
        }
        await drainToQuiescence();
      });

      if (hasUnsupportedFeature()) {
        return { status: "unsupported" };
      }
      if (settled?.outcome === "failed" && isIntegrityError(settled.error)) {
        finished = true;
        throw settled.error;
      }
      const decision = buildDecision();
      emitted = commands;
      return { status: "decided", decision };
    },
  };
}
