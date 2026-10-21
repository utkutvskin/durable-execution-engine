# Concepts

This page explains the ideas you need to write correct workflows: what durable execution promises, why workflow code must be deterministic, and how retries, idempotency, timers, signals and versioning fit together.

## Workflows and steps

A **workflow** is a function that describes a process. A **step** is one unit of side effect inside it: charge a card, call an API, write a row.

```ts
export const hello = defineWorkflow<HelloInput, HelloResult>("hello", async (ctx, input) => {
  const greeting = await ctx.step<string>("hello.build-greeting", { name: input.name });
  await ctx.sleep(1000);
  return { greeting };
});

export const buildGreeting = defineStep<HelloInput, string>("hello.build-greeting", {
  handler: ({ name }) => `hello, ${name}`,
});
```

The workflow never performs a side effect itself. It asks for a step by name through `ctx.step` and the engine runs the registered handler somewhere, possibly on another machine and possibly more than once. Workflows and steps are registered by name, so the name is part of your contract with every run already in flight.

## The event log

Everything that happens to a run is appended to its history as an event: `run_started`, `step_scheduled`, `step_completed`, `timer_started`, `signal_received`, `run_completed` and so on. The history is append-only and ordered by a sequence number. The status of a run is derived from it; nothing else is authoritative.

## Replay and determinism

A workflow function is not suspended in memory. When it needs to continue after a step result, a timer or a signal, the engine **runs the function again from the beginning** against the recorded history. A call that has a recorded result returns that result at once; the first call without one is the next thing to do.

For replay to reach the same place every time, workflow code must be deterministic:

- Use `ctx.now()`, `ctx.random()` and `ctx.uuid()` instead of `Date.now()`, `Math.random()` and random identifiers. They are recorded on the first run and returned from the history after that.
- Use `ctx.sleep()` instead of `setTimeout`.
- Do not read files, call the network or touch a database from workflow code. Put that in a step.
- Do not depend on iteration order of anything that is not ordered, or on module state that changes between runs.

The engine enforces part of this. Inside a decision, `Date.now`, `Math.random` and `setTimeout` throw a `ForbiddenApiError`. It also checks every call against the history: if the code asks for a different step type, or different input, than the one recorded at that position, the replay stops with a `NonDeterminismError` and writes nothing. A change like that needs a patch, see Versioning below.

Parallel work is deterministic too. `ctx.all`, `ctx.allSettled` and `ctx.select` decide by the order of events in the history, not by which promise happened to settle first.

## Steps, retries and dead letters

A step runs with a retry policy: `maxAttempts`, `initialIntervalMs`, `backoffCoefficient`, `maxIntervalMs`, `jitter` and `nonRetryableErrorNames`. The default is in `DEFAULT_RETRY_POLICY`; override it per step with `defineStep(type, { retry: {...}, timeoutMs })`.

- A thrown error is retried after the next backoff and recorded as a `step_attempt_failed` event with its retry time.
- A `NonRetryableError` is tried once and fails the step at once. The workflow sees a rejected `ctx.step` it can catch.
- A step that uses all its attempts moves to the **dead letter queue**. The run keeps waiting. An operator can fix the cause and requeue it from the API (`POST /v1/dead-letters/{id}/requeue`) or from the ui; it then gets a fresh attempt budget.
- A step that exceeds its `timeoutMs` fails that attempt with a `StepTimeoutError`.
- A task whose lease is lost three times is **quarantined** instead of redelivered forever, so one poison task cannot block a queue.

Attempt numbers come from a bookkeeping table, not from how often the queue delivered the task, so a worker crash does not use up a retry.

## Idempotency

The engine guarantees that the **recorded outcome** of a step happens once. It cannot guarantee the step's side effect happens once, because a worker can die after the side effect and before the result is committed. A step is therefore delivered **at least once**, and you make its effect safe to repeat:

- Pass an idempotency key to the system you call. The payment example reserves with the order id as key, so a retry returns the first reservation.
- Prefer upserts to inserts. The ETL example loads rows by id.
- Check before you act when the external system allows it.

The engine applies the same discipline to itself. A result is keyed by a logical attempt key and written in the same transaction as its event, so a duplicate delivery finds the result and records nothing. A workflow task decided from a history another writer has since extended records nothing and is superseded by that writer's own task.

Starting a run is idempotent as well. `POST /v1/runs` with an `Idempotency-Key` header creates the run once; a repeat in the same namespace returns it with `"created": false`, and a reuse with a different input is a 409.

## Timers and schedules

`ctx.sleep(ms)` appends a `timer_started` event and a row in `timers`. The run is suspended and consumes nothing. The timer loop fires due timers from the database in due-time order, so a sleep survives restarts and a worker that was down for an hour fires every missed timer when it returns. A timer that fires for a run that has already closed is closed without effect.

A **schedule** is a cron expression, a time zone and an overlap policy (`skip`, `buffer_one` or `allow_all`) stored in Postgres. The schedule loop starts a run for each trigger, including the ones missed during downtime, and a trigger ledger makes each trigger start exactly one run even with several loops racing. Schedules can be paused, resumed and backfilled over a past range.

## Signals and queries

A **signal** is an event delivered to a running workflow from outside: `wf run signal`, or `POST /v1/runs/{id}/signal`. The workflow receives it with `ctx.waitForSignal(name)`. Signals of one name are consumed in arrival order, one per wait; a signal that arrives before the wait is delivered when the wait starts. `ctx.select` waits for the first of several things, for example a signal against a timeout.

A **query** reads the state of a run without changing it. A workflow registers a handler with `ctx.setQueryHandler`, and a query replays the history to answer; it writes no event.

## Cancellation and compensation

Cancelling a run records `cancel_requested`. The workflow sees it at its next wait, which rejects with `CancelledError`. Code can register compensations with `ctx.onCancel(handler)`; on cancellation they run in reverse order of registration, which is how the payment saga releases a reservation. A compensation that throws does not stop the others. Terminating a run is the forceful form: it ends the run at once and runs no workflow code.

## Child workflows and fan-out

`ctx.startChild` and `ctx.executeChild` start another workflow as a run of its own, linked to the parent. `ctx.all(tasks, { concurrency })` takes a list of ctx calls, for example one `ctx.executeChild` per item, and runs them with bounded parallelism; it rejects with the failure that comes first in the history, and `ctx.allSettled` never rejects. A child closing writes its outcome into the parent's history. A `parentClosePolicy` (`cancel`, `terminate` or `abandon`) decides what happens to children when the parent closes first.

## Long-running workflows

History grows with every event, and replay cost grows with history. `ctx.continueAsNew(input)` closes the run and starts the next run of the same chain with fresh history, so a loop can run for years. The engine warns when history passes a threshold. The sticky decider keeps a live workflow in the memory of the worker that handled the previous task, so most tasks of a long run continue incrementally and replay from the beginning only on a cache miss. A history compactor can replace the events of closed runs with a snapshot.

## Versioning

Running workflows keep running while you deploy new code, so new code must replay old histories. Changing the order, type or input of existing calls breaks replay. Gate such a change with `ctx.patched("my-change-id")`: it returns `false` for histories recorded before the change and `true` for new runs, and records a marker so the answer is stable. Once no old run is open, remove the gate with `ctx.deprecatePatch`. A build refuses a history that is newer than its code with a `VersionMismatchError` rather than guess. `docs/VERSIONING.md` is the full guide, and recorded histories in `test/fixtures/histories` show how to pin old behavior in a test.

## Namespaces

A namespace is a tenant. An API key belongs to exactly one namespace and every query filters on it; another namespace's run answers 404 like a run that does not exist. Quotas (request rate, concurrent runs, pending tasks) are per namespace.

## Guarantees and limits

| The engine guarantees                                             | The engine does not guarantee                         |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| A committed event is never lost or reordered                      | That a step's side effect happens exactly once        |
| A run makes progress after any worker dies (given a live janitor) | That steps finish within a latency bound              |
| A step result and a decision are recorded once                    | Throughput beyond one Postgres (`docs/BENCHMARKS.md`) |
| A timer fires once, in due-time order                             | Wall-clock accuracy better than the loop interval     |
| Replay of an unchanged workflow reaches the same decision         | That changed code replays without a patch             |
