/**
 * What `ctx.select()` resolves with: the position in the branch list of the
 * branch that completed first, and the value it completed with.
 */
export interface SelectResult<TValue = unknown> {
  readonly index: number;
  readonly value: TValue;
}

/**
 * A function answering a query: given the optional query argument, returns
 * a value read from the workflow's current state without changing it.
 */
export type QueryHandler = (argument: unknown) => unknown;

/**
 * A compensation registered with `ctx.onCancel()`. It receives a context
 * that keeps scheduling steps, timers and signal waits after cancellation
 * was requested.
 */
export type CompensationHandler = (ctx: WorkflowContext) => Promise<void>;

/**
 * The API a workflow function is written against: scheduling steps and
 * timers, and reading time and randomness. Every member is backed by a
 * source a worker can substitute at replay time, so the same workflow body
 * makes the same decisions given the same history.
 */
export interface WorkflowContext {
  step<TResult>(stepType: string, input: unknown): Promise<TResult>;
  sleep(durationMs: number): Promise<void>;
  /**
   * Resolves with the payload of the next signal named `signalName` that the
   * run has not consumed yet. The nth call for a name consumes the nth signal
   * of that name, in the order they were recorded, so a signal that arrived
   * before the call is delivered at once.
   */
  waitForSignal<TPayload = unknown>(signalName: string): Promise<TPayload>;
  /**
   * Resolves with whichever of `branches` (promises from `ctx.step()`,
   * `ctx.sleep()` or `ctx.waitForSignal()`) completed first in the run's
   * recorded history. Replay picks the same branch because the choice is
   * made from the history order, never from timing.
   */
  select<TBranches extends readonly Promise<unknown>[]>(
    branches: TBranches,
  ): Promise<SelectResult<Awaited<TBranches[number]>>>;
  /**
   * Registers the function `queryRun` calls to read `queryName`. The latest
   * registration of a name wins. A handler must only read workflow state.
   */
  setQueryHandler(queryName: string, handler: QueryHandler): void;
  /**
   * Registers a compensation for work done so far. When the run is
   * cancelled, the compensations run one at a time in reverse registration
   * order, after the step that was running when cancellation was requested
   * has finished. A compensation that throws does not stop the others.
   * Compensations do not run when the run completes, fails or is terminated.
   */
  onCancel(handler: CompensationHandler): void;
  now(): Date;
  random(): number;
  uuid(): string;
}

/**
 * A workflow's implementation: given a `WorkflowContext` and its input,
 * resolves with the run's result or rejects to fail the run.
 */
export type WorkflowHandler<TInput = unknown, TResult = unknown> = (
  ctx: WorkflowContext,
  input: TInput,
) => Promise<TResult>;
