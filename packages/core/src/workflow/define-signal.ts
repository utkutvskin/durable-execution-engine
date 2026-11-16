/**
 * A signal a workflow waits for, as `defineSignal` returns it. Passed to
 * `ctx.waitForSignal()` in place of the name, it types the payload the wait
 * resolves with. `payloadType` is a type marker only and is never set.
 */
export interface SignalDefinition<TPayload = unknown> {
  readonly signalName: string;
  readonly payloadType?: TPayload;
}

/**
 * A query a workflow answers, as `defineQuery` returns it. Passed to
 * `ctx.setQueryHandler()` in place of the name, it makes the compiler check
 * the handler's argument and result. `argumentType` and `resultType` are
 * type markers only and are never set.
 */
export interface QueryDefinition<TArgument = undefined, TResult = unknown> {
  readonly queryName: string;
  readonly argumentType?: (argument: TArgument) => void;
  readonly resultType?: TResult;
}

/**
 * Declares a signal named `signalName` whose payload is a `TPayload`. The
 * signal is still sent and recorded by its name, so a run waiting through
 * the definition and one waiting through the string see the same signals.
 */
export function defineSignal<TPayload = unknown>(signalName: string): SignalDefinition<TPayload> {
  if (signalName.length === 0) {
    throw new Error("a signal needs a name");
  }
  return { signalName };
}

/**
 * Declares a query named `queryName` that takes a `TArgument` and answers
 * with a `TResult`. The query is still asked for by its name.
 */
export function defineQuery<TArgument = undefined, TResult = unknown>(
  queryName: string,
): QueryDefinition<TArgument, TResult> {
  if (queryName.length === 0) {
    throw new Error("a query needs a name");
  }
  return { queryName };
}

/**
 * The step type a `ctx.step()` call names, given as a string or a step
 * definition.
 */
export function stepTypeOf(step: string | { readonly stepType: string }): string {
  return typeof step === "string" ? step : step.stepType;
}

/**
 * The workflow type a child call names, given as a string or a workflow
 * definition.
 */
export function workflowTypeOf(workflow: string | { readonly workflowType: string }): string {
  return typeof workflow === "string" ? workflow : workflow.workflowType;
}

/**
 * The signal name a wait names, given as a string or a signal definition.
 */
export function signalNameOf(signal: string | { readonly signalName: string }): string {
  return typeof signal === "string" ? signal : signal.signalName;
}

/**
 * The query name a handler is registered under, given as a string or a
 * query definition.
 */
export function queryNameOf(query: string | { readonly queryName: string }): string {
  return typeof query === "string" ? query : query.queryName;
}
