/**
 * The validator of an update: throws to reject `argument` before anything
 * is written. It runs on the caller's side against the run's current
 * state and must not change that state.
 */
export type UpdateValidator<TArgument> = (argument: TArgument) => void;

/**
 * The handler of an update: changes the workflow's state and returns the
 * result the caller receives. It runs inside the workflow at the position
 * the update was accepted at, so it may read and write the same state the
 * workflow function closes over.
 */
export type UpdateHandler<TArgument, TResult> = (argument: TArgument) => TResult | Promise<TResult>;

/**
 * An update a workflow accepts, as `defineUpdate` returns it and
 * `ctx.setUpdateHandler()` registers it.
 */
export interface UpdateDefinition<TArgument = unknown, TResult = unknown> {
  readonly updateName: string;
  readonly validate?: UpdateValidator<TArgument>;
  readonly handler: UpdateHandler<TArgument, TResult>;
}

/**
 * What `defineUpdate` takes besides the name: an optional `validate` that
 * throws to reject an argument, and the `handler` that applies it.
 */
export interface UpdateSpec<TArgument, TResult> {
  readonly validate?: UpdateValidator<TArgument>;
  readonly handler: UpdateHandler<TArgument, TResult>;
}

/**
 * Raised when an update names a handler the workflow had not registered
 * with `ctx.setUpdateHandler()` by the point its replay stopped.
 */
export class UnknownUpdateError extends Error {
  readonly updateName: string;

  constructor(updateName: string) {
    super(`no update handler "${updateName}" is registered at the run's current point`);
    this.name = "UnknownUpdateError";
    this.updateName = updateName;
  }
}

/**
 * Raised when the validator of an update threw. Nothing was written to the
 * run. `cause` is what the validator threw.
 */
export class UpdateRejectedError extends Error {
  readonly updateName: string;

  constructor(updateName: string, cause: unknown) {
    super(
      `update "${updateName}" was rejected: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "UpdateRejectedError";
    this.updateName = updateName;
  }
}

/**
 * Declares an update named `updateName`: a validated, synchronous write
 * into a running workflow that returns a result. Register it from the
 * workflow function with `ctx.setUpdateHandler(definition)`; the latest
 * registration of a name wins.
 */
export function defineUpdate<TArgument = unknown, TResult = unknown>(
  updateName: string,
  spec: UpdateSpec<TArgument, TResult>,
): UpdateDefinition<TArgument, TResult> {
  if (updateName.length === 0) {
    throw new Error("an update needs a name");
  }
  return spec.validate === undefined
    ? { updateName, handler: spec.handler }
    : { updateName, validate: spec.validate, handler: spec.handler };
}
