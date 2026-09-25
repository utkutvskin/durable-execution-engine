/**
 * Thrown when workflow code calls a non-deterministic global API directly
 * instead of going through the matching `WorkflowContext` method. Workflow
 * code must never call `Date.now()`, `Math.random()` or `setTimeout()`
 * itself: each one has a deterministic equivalent on `WorkflowContext`
 * (`ctx.now()`, `ctx.random()`, `ctx.sleep()`) that a replay can serve
 * straight from recorded history, while the raw global reads real
 * wall-clock time, real randomness or schedules a real timer callback,
 * none of which a later replay of the same history can reproduce.
 */
export class ForbiddenApiError extends Error {
  readonly api: string;

  constructor(api: string) {
    super(`workflow code called "${api}" directly; use the matching WorkflowContext method instead`);
    this.name = "ForbiddenApiError";
    this.api = api;
  }
}

function forbid(api: string): never {
  throw new ForbiddenApiError(api);
}

const systemDateNow = Date.now;
const systemMathRandom = Math.random;
const systemSetTimeout = globalThis.setTimeout;

let activeGuards = 0;

function patchGlobals(): void {
  Date.now = () => forbid("Date.now()");
  Math.random = () => forbid("Math.random()");
  globalThis.setTimeout = (() => forbid("setTimeout()")) as unknown as typeof setTimeout;
}

function restoreGlobals(): void {
  Date.now = systemDateNow;
  Math.random = systemMathRandom;
  globalThis.setTimeout = systemSetTimeout;
}

/**
 * Runs `execute` with `Date.now`, `Math.random` and `setTimeout` replaced by
 * versions that raise `ForbiddenApiError`, restoring the true originals
 * (captured once at module load, before anything could have patched them)
 * once `execute`'s returned promise settles, whether it resolves or
 * rejects. `execute` is expected to await its workflow decision through to
 * quiescence before returning, since that is the window during which
 * workflow code (as opposed to the surrounding engine code) actually runs.
 *
 * Patching is reference-counted rather than save-and-restore per call:
 * `runDecisionLoop` can run several decisions concurrently (replaying the
 * same history more than once, for instance), so overlapping calls only
 * patch on the first entry and only restore once the last one exits.
 * Without the count, an inner call's "original" would actually be an
 * outer call's patched version, and restoring it would leave the globals
 * permanently forbidden after both calls return.
 */
export async function guardAgainstForbiddenApis<TResult>(execute: () => Promise<TResult>): Promise<TResult> {
  if (activeGuards === 0) {
    patchGlobals();
  }
  activeGuards += 1;

  try {
    return await execute();
  } finally {
    activeGuards -= 1;
    if (activeGuards === 0) {
      restoreGlobals();
    }
  }
}
