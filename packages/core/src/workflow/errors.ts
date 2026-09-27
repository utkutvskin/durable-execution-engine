/**
 * Thrown by `runDecisionLoop` when a replay's `ctx.step()` call disagrees
 * with the `step_scheduled` event already recorded in history for the same
 * `stepId`, either on `stepType` or on `input`. A `stepId` is assigned
 * purely from call order, so this only happens when the workflow code that
 * produced the history and the workflow code doing the replay would not
 * have made the same decision at that point: the two are running different
 * logic over the same history, which is exactly the corruption a durable
 * execution engine has to make impossible to miss.
 */
export class NonDeterminismError extends Error {
  readonly stepId: string;
  readonly expected: { readonly stepType: string; readonly input: unknown };
  readonly found: { readonly stepType: string; readonly input: unknown };

  constructor(
    stepId: string,
    expected: { readonly stepType: string; readonly input: unknown },
    found: { readonly stepType: string; readonly input: unknown },
  ) {
    super(
      `non-deterministic replay at "${stepId}": history recorded step type ` +
        `"${expected.stepType}" with input ${JSON.stringify(expected.input)}, ` +
        `but the workflow code now calls step type "${found.stepType}" with input ` +
        JSON.stringify(found.input),
    );
    this.name = "NonDeterminismError";
    this.stepId = stepId;
    this.expected = expected;
    this.found = found;
  }
}

/**
 * Thrown by a `StepDefinition` produced by `defineStep` when its handler is
 * still pending once `timeoutMs` elapses. The step's own attempt does not
 * stop running in the background (there is no cooperative cancellation for
 * an arbitrary handler), but the caller sees this rejection instead of
 * waiting on it forever, and can act on it (retry, mark the attempt dead)
 * the same way it would react to the handler rejecting on its own.
 */
export class StepTimeoutError extends Error {
  readonly stepType: string;
  readonly timeoutMs: number;

  constructor(stepType: string, timeoutMs: number) {
    super(`step "${stepType}" did not complete within its ${String(timeoutMs)}ms timeout`);
    this.name = "StepTimeoutError";
    this.stepType = stepType;
    this.timeoutMs = timeoutMs;
  }
}
