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
