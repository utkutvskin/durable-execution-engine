import type { WorkflowEvent } from "../event-store/events.js";
import type { WorkflowHandler } from "./context.js";
import { replayHistory, type DecisionLoopOptions } from "./decision-loop.js";
import { guardAgainstForbiddenApis } from "./sandbox.js";

/**
 * Raised when a query names a handler the workflow had not registered with
 * `ctx.setQueryHandler()` by the point its replay stopped.
 */
export class UnknownQueryError extends Error {
  readonly queryName: string;

  constructor(queryName: string) {
    super(`no query handler "${queryName}" is registered at the run's current point`);
    this.name = "UnknownQueryError";
    this.queryName = queryName;
  }
}

/**
 * Answers `queryName` for a run without changing it: replays `handler` over
 * `history` exactly as a decision would, then calls the query handler the
 * workflow had registered by the point the replay stopped. The commands the
 * replay discovers are thrown away, so a query never schedules a step or a
 * timer, and nothing here can append an event. Rejects with
 * `UnknownQueryError` when no such handler is registered.
 */
export async function runQuery<TInput>(
  handler: WorkflowHandler<TInput>,
  input: TInput,
  history: readonly WorkflowEvent[],
  options: DecisionLoopOptions,
  queryName: string,
  argument?: unknown,
): Promise<unknown> {
  const { queryHandlers } = await replayHistory(handler, input, history, options);
  const queryHandler = queryHandlers.get(queryName);
  if (queryHandler === undefined) {
    throw new UnknownQueryError(queryName);
  }
  return guardAgainstForbiddenApis(() => Promise.resolve(queryHandler(argument)));
}
