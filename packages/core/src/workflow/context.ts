/**
 * The API a workflow function is written against: scheduling steps and
 * timers, and reading time and randomness. Every member is backed by a
 * source a worker can substitute at replay time, so the same workflow body
 * makes the same decisions given the same history.
 */
export interface WorkflowContext {
  step<TResult>(stepType: string, input: unknown): Promise<TResult>;
  sleep(durationMs: number): Promise<void>;
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
