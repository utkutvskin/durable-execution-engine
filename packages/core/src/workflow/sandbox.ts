import { AsyncLocalStorage, createHook } from "node:async_hooks";

/**
 * Thrown when workflow code calls a non-deterministic global API directly
 * instead of going through the matching `WorkflowContext` method. Workflow
 * code must never read the clock (`Date.now()`, `new Date()`, `Date()`,
 * `performance.now()`), draw randomness (`Math.random()`,
 * `crypto.randomUUID()`) or schedule real timers (`setTimeout()`,
 * `setInterval()`, `setImmediate()`) itself: the first two have
 * deterministic equivalents on `WorkflowContext` (`ctx.now()`,
 * `ctx.random()`, `ctx.uuid()`) and the third has `ctx.sleep()`, which a
 * replay can serve straight from recorded history, while the raw globals
 * read real wall-clock time, real randomness or schedule a real callback,
 * none of which a later replay of the same history can reproduce.
 */
export class ForbiddenApiError extends Error {
  readonly api: string;

  constructor(api: string) {
    super(
      `workflow code called "${api}" directly; use the matching WorkflowContext method instead`,
    );
    this.name = "ForbiddenApiError";
    this.api = api;
  }
}

/**
 * Thrown when workflow code is still waiting on something other than a
 * `WorkflowContext` call after the decision went quiet, for example a
 * promise on a timer or a file read that does not come from `ctx`. Such code
 * would resume after the decision was consumed and push commands nowhere,
 * leaving the run waiting forever, so the decision fails instead.
 */
export class WorkflowActiveAfterQuiescenceError extends Error {
  readonly resources: readonly string[];

  constructor(resources: readonly string[]) {
    super(
      `workflow code is still active after the decision went quiet (${resources.join(", ")}); await only WorkflowContext calls in workflow code`,
    );
    this.name = "WorkflowActiveAfterQuiescenceError";
    this.resources = resources;
  }
}

function forbid(api: string): never {
  throw new ForbiddenApiError(api);
}

interface DecisionScope {
  readonly pending: Map<number, PendingResource>;
}

interface PendingResource {
  readonly type: string;
  readonly resource: object;
}

const systemDate = globalThis.Date;
const systemDateNow = Date.now;
const systemMathRandom = Math.random;
const systemSetTimeout = globalThis.setTimeout;
const systemSetInterval = globalThis.setInterval;
const systemSetImmediate = globalThis.setImmediate;
const systemPerformanceNow = Reflect.get(performance, "now");
const systemRandomUUID = Reflect.get(globalThis.crypto, "randomUUID");

const guardedContext = new AsyncLocalStorage<DecisionScope>();

const IGNORED_RESOURCE_TYPES = new Set(["PROMISE", "Microtask", "TickObject"]);

const trackedResources = new Map<number, DecisionScope>();

const resourceHook = createHook({
  init(asyncId, type, _triggerAsyncId, resource) {
    const scope = guardedContext.getStore();
    if (scope === undefined || IGNORED_RESOURCE_TYPES.has(type)) {
      return;
    }
    scope.pending.set(asyncId, { type, resource });
    trackedResources.set(asyncId, scope);
  },
  after(asyncId) {
    forget(asyncId);
  },
  destroy(asyncId) {
    forget(asyncId);
  },
});

function forget(asyncId: number): void {
  const scope = trackedResources.get(asyncId);
  if (scope !== undefined) {
    scope.pending.delete(asyncId);
    trackedResources.delete(asyncId);
  }
}

let activeGuards = 0;

function isGuarded(): boolean {
  return guardedContext.getStore() !== undefined;
}

const guardedDate: DateConstructor = new Proxy(systemDate, {
  construct(target, args: unknown[], newTarget) {
    if (args.length === 0 && isGuarded()) {
      return forbid("new Date()");
    }
    return Reflect.construct(
      target,
      args,
      newTarget === guardedDate ? target : newTarget,
    ) as object;
  },
  apply(target, thisArg, args: unknown[]) {
    if (isGuarded()) {
      return forbid("Date()");
    }
    return Reflect.apply(target, thisArg, args) as string;
  },
});

function patchGlobals(): void {
  Date.now = () => (isGuarded() ? forbid("Date.now()") : systemDateNow());
  Math.random = () => (isGuarded() ? forbid("Math.random()") : systemMathRandom());
  globalThis.Date = guardedDate;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) =>
    isGuarded()
      ? forbid("setTimeout()")
      : systemSetTimeout(...args)) as unknown as typeof setTimeout;
  globalThis.setInterval = (...args: Parameters<typeof setInterval>) =>
    isGuarded() ? forbid("setInterval()") : systemSetInterval(...args);
  globalThis.setImmediate = ((...args: Parameters<typeof setImmediate>) =>
    isGuarded()
      ? forbid("setImmediate()")
      : systemSetImmediate(...args)) as unknown as typeof setImmediate;
  performance.now = () =>
    isGuarded()
      ? forbid("performance.now()")
      : Reflect.apply(systemPerformanceNow, performance, []);
  globalThis.crypto.randomUUID = () =>
    isGuarded()
      ? forbid("crypto.randomUUID()")
      : Reflect.apply(systemRandomUUID, globalThis.crypto, []);
}

function restoreGlobals(): void {
  Date.now = systemDateNow;
  Math.random = systemMathRandom;
  globalThis.Date = systemDate;
  globalThis.setTimeout = systemSetTimeout;
  globalThis.setInterval = systemSetInterval;
  globalThis.setImmediate = systemSetImmediate;
  performance.now = systemPerformanceNow;
  globalThis.crypto.randomUUID = systemRandomUUID;
}

function isStillPending({ type, resource }: PendingResource): boolean {
  if (type === "Timeout" || type === "Immediate") {
    return (resource as { _destroyed?: boolean })._destroyed !== true;
  }
  return true;
}

function assertQuiet(scope: DecisionScope): void {
  const active = [...scope.pending.values()].filter(isStillPending).map(({ type }) => type);
  if (active.length > 0) {
    throw new WorkflowActiveAfterQuiescenceError([...new Set(active)]);
  }
}

/**
 * Runs `read` outside the forbidden API guard, so engine code called from
 * inside a decision (a `ClockSource`, a `RandomSource`) can use the real
 * globals the workflow code itself may not.
 */
export function runUnguarded<TResult>(read: () => TResult): TResult {
  return guardedContext.exit(read);
}

/**
 * Waits for one macrotask boundary using the real `setImmediate`, which is
 * refused inside a guarded call chain.
 */
export function waitForMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    systemSetImmediate(resolve);
  });
}

/**
 * Runs `execute` with the non-deterministic globals replaced by versions
 * that raise `ForbiddenApiError` (`Date.now`, `new Date()` without
 * arguments, `Date()`, `Math.random`, `performance.now`,
 * `crypto.randomUUID`, `setTimeout`, `setInterval`, `setImmediate`),
 * restoring the true originals (captured once at module load, before
 * anything could have patched them) once `execute`'s returned promise
 * settles, whether it resolves or rejects. `execute` is expected to await
 * its workflow decision through to quiescence before returning, since that
 * is the window during which workflow code (as opposed to the surrounding
 * engine code) actually runs. When `execute` returns while code started
 * inside it still waits on a timer, a request or a file operation that is
 * not a `WorkflowContext` call, the call rejects with
 * `WorkflowActiveAfterQuiescenceError`.
 *
 * Only code running inside `execute`'s own asynchronous call chain is
 * refused: other code in the same process, such as a step handler running
 * concurrently with a decision, still gets the real functions.
 *
 * Patching is reference-counted rather than save-and-restore per call:
 * `runDecisionLoop` can run several decisions concurrently (replaying the
 * same history more than once, for instance), so overlapping calls only
 * patch on the first entry and only restore once the last one exits.
 * Without the count, an inner call's "original" would actually be an
 * outer call's patched version, and restoring it would leave the globals
 * permanently forbidden after both calls return.
 */
export async function guardAgainstForbiddenApis<TResult>(
  execute: () => Promise<TResult>,
): Promise<TResult> {
  if (activeGuards === 0) {
    patchGlobals();
    resourceHook.enable();
  }
  activeGuards += 1;
  const scope: DecisionScope = { pending: new Map() };

  try {
    const result = await guardedContext.run(scope, execute);
    assertQuiet(scope);
    return result;
  } finally {
    for (const asyncId of scope.pending.keys()) {
      trackedResources.delete(asyncId);
    }
    activeGuards -= 1;
    if (activeGuards === 0) {
      restoreGlobals();
      resourceHook.disable();
    }
  }
}
