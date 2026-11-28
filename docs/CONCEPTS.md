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

A step, a child workflow, a signal and a query can also be named by its **definition** instead of its string: `ctx.step(buildGreeting, { name })`, `ctx.executeChild(ship, input)`, `ctx.waitForSignal(approved)` with `approved = defineSignal<Approval>("approved")`, and `ctx.setQueryHandler(status, handler)` with `status = defineQuery<undefined, string>("status")`. The compiler then checks the input and types the result, and a wrong input type does not compile. Updates are typed by `defineUpdate` already. The definition still records the step, child or signal by its name, so both forms write the same history and can replay each other's runs.

## The event log

Everything that happens to a run is appended to its history as an event: `run_started`, `step_scheduled`, `step_completed`, `timer_started`, `signal_received`, `run_completed` and so on. The history is append-only and ordered by a sequence number. The status of a run is derived from it; nothing else is authoritative.

## Replay and determinism

A workflow function is not suspended in memory. When it needs to continue after a step result, a timer or a signal, the engine **runs the function again from the beginning** against the recorded history. A call that has a recorded result returns that result at once; the first call without one is the next thing to do.

For replay to reach the same place every time, workflow code must be deterministic:

- Use `ctx.now()`, `ctx.random()` and `ctx.uuid()` instead of `Date.now()`, `new Date()`, `performance.now()`, `Math.random()` and `crypto.randomUUID()`. `ctx.now()` is recorded: the first time a call is reached, the engine writes a `time_recorded` event holding the time of the event that triggered the decision, and every replay answers the nth call from the nth such event. `ctx.random()` and `ctx.uuid()` are not recorded: they come from a generator seeded by the run id and a counter of value calls, so a replay of the same code draws the same values. `new Date(value)` with an argument is fine; only reading the current time is refused.
- Use `ctx.sleep()` instead of `setTimeout`, `setInterval` and `setImmediate`.
- Do not read files, call the network or touch a database from workflow code. Put that in a step.
- Do not depend on iteration order of anything that is not ordered, or on module state that changes between runs.

The engine enforces part of this. Inside a decision, `Date.now`, `new Date()` without an argument, `Date()`, `performance.now`, `Math.random`, `crypto.randomUUID`, `setTimeout`, `setInterval` and `setImmediate` throw a `ForbiddenApiError`. If workflow code is still waiting on something that is not a `ctx` call when the decision goes quiet (a timer it started with a saved reference to `setTimeout`, a file read), the decision fails with a `WorkflowActiveAfterQuiescenceError` instead of leaving the run waiting forever. The engine also checks every call against the history. Steps, timers (with their duration), child workflows and patches form one ordered sequence of commands. If the code issues a different command than the one recorded at that position (another step type, other input, another timer duration, a sleep where a step was recorded), or finishes without issuing a command the history holds (a removed trailing step), the replay stops with a `NonDeterminismError` and writes nothing. Timers recorded before the duration was stored are compared by position and id only. Inputs are compared as the event log stores them (canonical JSON), so an input holding `undefined`, a `Date`, `NaN` or `-0` replays cleanly. A change like that needs a patch, see Versioning below.

Parallel work is deterministic too. `ctx.all`, `ctx.allSettled` and `ctx.select` decide by the order of events in the history, not by which promise happened to settle first.

## Steps, retries and dead letters

A step runs with a retry policy: `maxAttempts`, `initialIntervalMs`, `backoffCoefficient`, `maxIntervalMs`, `jitter` and `nonRetryableErrorNames`. The default is in `DEFAULT_RETRY_POLICY`; override it per step with `defineStep(type, { retry: {...}, timeoutMs })`.

- A thrown error is retried after the next backoff and recorded as a `step_attempt_failed` event with its retry time.
- A `NonRetryableError` is tried once and fails the step at once. The workflow sees a rejected `ctx.step` it can catch.
- A step that uses all its attempts moves to the **dead letter queue** for the operator, and the workflow sees the failure at once: `ctx.step()` rejects with a `StepFailedError` (`stepId`, `stepType`, and the step's last error as `cause`) that the workflow can catch to compensate; uncaught, it fails the run. The failure is final: a requeued dead letter is acknowledged without running the step again, because the step already has its result. A step that fails with a `NonRetryableError` rejects with the original error instead.
- A failure keeps the error's `name`, `message`, the serializable own properties as `details` and the `cause` chain, so a custom error class arrives in the workflow with its type and details (`error.name`, `error.details`, `error.cause`). A compensation that throws is recorded as a `compensation_failed` event and the other compensations still run.
- A step that exceeds its `timeoutMs` (also called `startToCloseTimeoutMs`) fails that attempt with a `StepTimeoutError`.
- `scheduleToCloseTimeoutMs` bounds the whole step, every attempt and every backoff, from the moment it was scheduled. When it passes, during an attempt, before one starts or because the next retry would start after it, the step fails without another retry and `ctx.step()` rejects with a `StepScheduleToCloseTimeoutError` (`timeoutMs`, and the last attempt's error as `cause` when a retry was cut off). The error is rebuilt with its class on replay, so `instanceof` works in the workflow.
- A long step reports progress with `context.heartbeat(details)`. With `heartbeatTimeoutMs` set, an attempt that goes that long without a heartbeat is aborted and fails with a retryable `StepHeartbeatTimeoutError`. The last details are stored in `step_heartbeats`, and the next attempt receives them as `context.heartbeatDetails`, so it can resume where the stopped attempt was instead of starting over. `context.attempt` says which attempt is running.
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

A signal may carry a **signal id**; a repeated id anywhere in the run's continue-as-new chain is recorded once. **Signal-with-start** signals the run that holds a workflow key and starts it first when there is none, so a caller does not need to know whether the run exists. When a run continues as new, the signals it received but did not consume are recorded again at the start of the next run, and a signal sent to the old run is forwarded to the current one, so no signal is lost at the hand-over.

An **event** is addressed by a name and a correlation key instead of a run id: `POST /v1/events`. A workflow waits for it with `ctx.waitForEvent(name, { match, timeoutMs })`. Every event is kept for a buffer period, so a run that starts waiting after the event arrived still receives it, and each run receives an event at most once. An **event trigger** starts a run for every matching event. The timeout of a wait is a durable timer like `ctx.sleep`.

`ctx.condition(predicate, timeoutMs)` waits until a predicate over the workflow's own state holds, for example "two approvals arrived". The engine checks the predicate after each history event the replay applies, so it resolves at the same point on every replay; with a timeout it resolves `false` when the timer fires first.

An **update** changes the state of a run and returns a result to the caller: `wf run update`, or `POST /v1/runs/{id}/updates/{name}`. The workflow declares it with `defineUpdate(name, { validate, handler })` and registers it with `ctx.setUpdateHandler`. The validator runs first, against the run's current state; when it throws, the caller gets the error and nothing is recorded. An accepted update is recorded as `update_accepted`, and its handler runs inside the workflow at exactly that point of the history, so replay applies every update in the same order to the same state. The handler's result is recorded as `update_completed` and returned to the caller. Updates sent at the same time are applied one after another in the order they were recorded.

## Cancellation and compensation

Cancelling a run records `cancel_requested`. The workflow sees it at its next wait, which rejects with `CancelledError`. Code can register compensations with `ctx.onCancel(handler)`; on cancellation they run in reverse order of registration, which is how the payment saga releases a reservation. A compensation that throws does not stop the others. Terminating a run is the forceful form: it ends the run at once and runs no workflow code.

## Child workflows and fan-out

`ctx.startChild` and `ctx.executeChild` start another workflow as a run of its own, linked to the parent. `ctx.all(tasks, { concurrency })` takes a list of ctx calls, for example one `ctx.executeChild` per item, and runs them with bounded parallelism; it rejects with the failure that comes first in the history, and `ctx.allSettled` never rejects. A child closing writes its outcome into the parent's history. A `parentClosePolicy` (`cancel`, `terminate` or `abandon`) decides what happens to children when the parent closes first.

## Long-running workflows

History grows with every event, and replay cost grows with history. `ctx.continueAsNew(input)` closes the run and starts the next run of the same chain with fresh history, so a loop can run for years. The engine warns when history passes a threshold. The sticky decider keeps a live workflow in the memory of the worker that handled the previous task, so most tasks of a long run continue incrementally and replay from the beginning only on a cache miss. A history compactor can replace the events of closed runs with a snapshot.

## Versioning

Running workflows keep running while you deploy new code, so new code must replay old histories. Changing the order, type or input of existing calls breaks replay. Gate such a change with `ctx.patched("my-change-id")`: it returns `false` for histories recorded before the change and `true` for new runs, and records a marker so the answer is stable. Once no old run is open, remove the gate with `ctx.deprecatePatch`. A build refuses a history that is newer than its code with a `VersionMismatchError` rather than guess. `docs/VERSIONING.md` is the full guide, and recorded histories in `test/fixtures/histories` show how to pin old behavior in a test.

## Search attributes and visibility

A run can carry search attributes, typed values (strings, numbers, booleans) set when it starts and changed by the workflow with `ctx.upsertSearchAttributes`, and a memo, a JSON value shown with the run and never searched. An upsert is a `search_attributes_upserted` event like any other decision: the engine writes it to the run row when the decision is stored, a replay matches the nth upsert with the nth recorded one (a different upsert is non-determinism), and continue-as-new hands the current attributes and the memo to the next run, whose `run_started` event holds them. Operators find runs with a small query language (`status = 'FAILED' and customerId = 'c-1'`) over the run fields and the attributes; the engine compiles it into parameterized SQL over an indexed `jsonb` column, never into SQL text, and refuses a query it cannot parse with the position of the problem.

## Namespaces

A namespace is a tenant. An API key belongs to exactly one namespace and every query filters on it; another namespace's run answers 404 like a run that does not exist. Quotas (request rate, concurrent runs, pending tasks) are per namespace.

## Priorities, pools and fairness

A run has a priority, an integer from -1000 to 1000 (default 0) set when it starts. Every task of the run carries it, a database trigger copies it from the run when the task is written, and child runs and the next run of a continue-as-new chain inherit it. A worker takes the highest priority first. Among tasks of equal priority it takes turns across namespaces: each namespace's oldest task comes before any namespace's second, and the namespace served least recently goes first, so a tenant with a deep backlog cannot hold back a tenant with a few tasks. The turn is a sequence number stamped on every lease, so it needs no shared counter that every worker would write.

An engine runs two pools on one queue: one for decisions (`workflowConcurrency`) and one for steps (`stepConcurrency`). A step that takes an hour holds a step slot, never a decision slot, so the workflows it does not belong to keep moving.

## Concurrency keys

A workflow or a step can limit how many of its runs or executions run at once for one business key, such as one per customer:

```ts
const checkout = defineWorkflow("checkout", handler, {
  concurrency: { key: (order: Order) => order.customerId, limit: 1 },
});
const charge = defineStep("charge", {
  handler,
  concurrency: { key: (payment: Payment) => payment.account, limit: 2 },
});
```

The key is evaluated from the input by the worker, since only the worker has the code. The first time a worker leases a task of a run whose workflow has a rule, or a step task whose step has one, it records the key and the limit on the run (and its open tasks) or on the task and gives the lease back at once, without running anything. From then on a database trigger copies the run's key onto every new task of the run, and the dequeue statement leases a keyed task only when it holds a slot: a row in `concurrency_slots`, whose primary key (namespace, pool, key, slot number below the limit) makes two holders of one slot impossible however many workers dequeue at once. Runs and steps are separate pools.

A run holds its slot while it has an open task, pending or leased, and a trigger frees it when its last open task closes. A run that sleeps, waits for a signal, an event or a child has no open task, so it holds no slot, and when it wakes its task waits for one like any other. A step holds its slot while its lease is live: an ack or nack frees it, and a lease that expires because a worker died frees it too, so the next dequeue can give the slot to the redelivered task or to another. A run's slot is not tied to one lease: when a worker dies mid-decision the run keeps its slot and the redelivered task continues it.

Every acquisition and release is written to `concurrency_slot_history` in the order of one sequence, and the invariant checker's `concurrency-limit-held` reads it to prove that no key ever had more holders than its limit. `dee_concurrency_slots_held` and `dee_concurrency_queued_tasks` report each key, and the run page shows a run that waits for a slot.

## Shared rate limits, debounce and singleton starts

A rate limit is a sliding window kept in Postgres: at most `limitPerPeriod` admissions in any `periodMs`. Each call is one statement that takes an advisory lock on the bucket, deletes the admissions that left the window, and records the call if the window has room, so every process on the database shares the limit and a bucket never holds more rows than its limit. The api uses it for each namespace's request rate. A step can carry one, per key when it has a key function:

```ts
const charge = defineStep("charge", {
  handler,
  rateLimit: { limitPerPeriod: 100, periodMs: 60_000, key: (payment: Payment) => payment.provider },
});
```

and `startEngine({ queueRateLimit })` caps the steps started from a queue. A step task that a limit refuses is handed back to the queue, visible again when the window has room; it did not run, so it counts no attempt.

Three start options decide whether and when a start creates its run. An idempotency key with a TTL maps to its run only until the TTL ends; the next start then frees the key from the old run and creates a new one. A debounced start records its input in `pending_starts` and returns the id its run will have; starts of the same key inside the window replace the input, and the engine's schedule loop starts the run when the window closes. A singleton start checks, under an advisory lock on its key, that no run of the key is open; it is created, refused, or queued in `pending_starts` until the open run closes. Both pending kinds are fired by any engine's schedule loop, each in its own transaction.

## Pause, resume and schedule policies

A pause holds back work without losing it. `createPauseControl` writes a row to `pauses` for a namespace, a queue of a namespace or a run, and the dequeue statement skips the lane of a paused namespace or queue and passes over the tasks of a paused run. Nothing else changes: tasks stay `PENDING` in their order, timers fire and enqueue their workflow task into the held state, signals and events are recorded, and a task leased before the pause runs to its end. An expired lease of a paused run is reclaimed only after the resume. Resuming deletes the row, and the next poll leases the held tasks in the order they would have had.

A schedule's overlap policy decides what a trigger does while a run of the schedule is open. `skip` drops it, `buffer_one` keeps only the latest and starts it when the run closes, `allow_all` starts it anyway, and `cancel_other` requests cancellation of the open runs in the trigger's transaction and buffers the trigger like `buffer_one`, so the new run starts only after the cancelled one closed. Every trigger is a row of `schedule_triggers` keyed by schedule and instant, written in the transaction that handles it while the schedule row is locked, which is why a backfill of a range, repeated or run by three callers at once, handles each instant once. A backfill can override the overlap policy, so `allow_all` starts every hour of a range even for a schedule that skips. Pausing a schedule stops its ticks and its buffered trigger; a backfill still works on a paused schedule.

## Statements per run

Throughput on one Postgres is bounded by the number of statements a run costs, so the hot paths are SQL functions called as one statement each: `insert_run` writes a run with its `run_started` event and first workflow task, `append_run_events` checks the sequence and appends, `record_step_result` records a step's result and, for the engine, also enqueues the run's next workflow task and acks the step task, `record_workflow_task` records a decision with its idempotency and sequence checks, and `close_run` writes the closing projection and withdraws the run's waiting tasks. A decision without side effects needs no transaction; one that closes the run is two calls in one transaction. The three-step run of the benchmark costs 14 statements (`docs/BENCHMARKS.md`).

A run has at most one pending workflow task. A workflow task is only a request to decide from the whole history, so when one is already waiting, a new request merges into it instead of queueing a second decision: twenty steps finishing at once cause one replay. A waiting task that was already delivered once is replaced rather than merged, because its key may already hold a recorded decision, and a redelivery of it would decide nothing.

A worker sends the acks and the heartbeats of the tasks that finish or beat in the same turn of the event loop as one statement each. A heartbeat moves `lease_extended_until`, a column no index covers, so Postgres can write it as a HOT update without touching the indexes of `tasks`; a lease ends at the later of that column and the `visible_at` the dequeue set.

## Leader election and wake-ups

Some work must happen once per queue, not once per process: firing due timers, starting cron runs, reclaiming expired leases and recovering stalled runs, compacting closed histories. Every engine is a candidate, and the one that holds a Postgres session advisory lock for its queue and schema runs those loops; the others only run tasks. A candidate tries the lock once per lease period (one second by default) on a session of its own. Postgres releases a session lock when the session ends, so when a leader's process dies, the next attempt of another engine takes over, within two lease periods; a leader that loses its session stops its loops at once. The loops were already safe to run in several processes, so a short overlap during a handover costs duplicated reads, not duplicated effects.

Due timers are fired in batches: one transaction takes up to a hundred due timers with `for update skip locked`, locks their runs, appends one `timer_fired` per timer, marks them fired and enqueues one workflow task per run.

Workers poll, backing off to half a second when the queue is empty. With wake-ups on, the `tasks` insert trigger sends one `NOTIFY` per transaction and queue, and an engine listening on a dedicated session polls at once. The notification is only a hint: polling stays on, so a notification lost while the listening session reconnects costs latency, never a task. See `docs/DEPLOYMENT.md` for the sessions this needs behind a connection pooler.

## Retention and cleanup

A finished task has done its job once its result is recorded, so it does not stay in `tasks`, where every dequeue has to step over it. The elected engine moves completed tasks that settled more than 30 seconds ago to `task_history`, an append-only table, a thousand at a time; recent completions stay a little while because the dequeue reads them to know which namespace it served last. The view `all_tasks` shows both tables as one.

Closed runs keep their execution data for as long as their namespace's retention says, then the same loop purges it: the decision results, failed step attempts, timers, schedule triggers, requeued dead letters, task history and released concurrency slots of runs that closed longer ago than the retention. A run is purged once and marked with `purged_at`. Its row, its events, its step results and its open dead letters stay, so the run can still be listed and read; the history compactor (`compaction`, `--compact-interval`) is what shrinks its events. Each namespace can set its own retention, or keep its runs forever; without a retention, nothing is purged. Open runs are never touched: a run that must live for a long time keeps its history short with continue-as-new.

## Partitioned history, archives and read replicas

`run_events` is split into one partition per day, by the day each run was created, so every event of a run sits in the same partition. The elected engine creates the next seven days ahead of time. Once retention has purged every run created on a day, and an hour has passed since that day ended, the engine writes the day's partition to an archive, if one is configured (`archiveDirectory`, `wf worker --archive-dir`), and then detaches and drops it, which frees the space at once instead of leaving dead rows for vacuum. A day keeps its partition for as long as one of its runs is open or not yet purged.

An archive is a newline-delimited JSON file per partition: a header line, then one line per event with its run, sequence number, time, event format version and payload. `wf history import <file> --out <dir>` turns it back into one history export per run, which `wf replay` replays against the current code, so an archived run can still be checked after its rows are gone.

With a read replica (`DATABASE_READ_URL`, `wf serve --database-read-url`), the API reads run lists, run pages, histories and the metrics scrape from the replica. A process that just started, signalled or changed a run reads that run, and after a start the run list of its namespace, from the primary for ten seconds, and a run the replica does not have yet is read from the primary, so a client sees its own writes.

## Guarantees and limits

| The engine guarantees                                             | The engine does not guarantee                         |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| A committed event is never lost or reordered                      | That a step's side effect happens exactly once        |
| A run makes progress after any worker dies (given a live janitor) | That steps finish within a latency bound              |
| A step result and a decision are recorded once                    | Throughput beyond one Postgres (`docs/BENCHMARKS.md`) |
| A timer fires once, in due-time order                             | Wall-clock accuracy better than the loop interval     |
| Replay of an unchanged workflow reaches the same decision         | That changed code replays without a patch             |

## Run and execution timeouts

A run can bound its own life. `runTimeoutMs` ends one run, `executionTimeoutMs` ends a whole continue-as-new chain at a fixed deadline. Both are set when the run starts: `POST /v1/runs` accepts them in the body, and `ctx.startChild` and `ctx.executeChild` accept them in their options. A run created with a timeout gets a durable timer (`run-timeout`, `execution-timeout`) in the same transaction. When it comes due, the timer loop appends `run_timed_out` (with `kind` `run` or `execution`) and closes the run: the run becomes `TIMED_OUT`, its waiting tasks are withdrawn and its parent receives a `child_failed` event named `TimedOutError`. A run that closed first just cancels its timer. A continued run keeps the chain's deadline and restarts its own run timeout.

`ctx.sleep()` rejects a negative, `NaN` or infinite duration with an `InvalidSleepDurationError`.

## Payload codec and encryption

A `PayloadCodec` turns a user payload into the JSON value that is stored and back. Payloads are the values that come from users and from their code: run inputs and results, step inputs and results, signal, update and event payloads, heartbeat details and schedule inputs. They are encoded where they enter the engine and decoded only where they leave it for code or a person: the API encodes what clients send, the worker decodes the history before the workflow replays it, encodes the commands of a decision, decodes a step's input and encodes its result. Everything in between (the run row, the events, the task payloads, the child run created from a `child_started` event, the dead letter copied from a task) carries the encoded value as it is, so no other path needs to know about the codec.

An encoded payload is an envelope, a JSON object whose `$dee_codec` names the codec, so it fits every `jsonb` column. `createEncryptionCodec` writes `{ "$dee_codec": "aes-256-gcm", "keyId", "iv", "tag", "data" }` with a random IV per payload and the key id as authenticated data; decoding looks the key up by its id, which is how rotation keeps old runs readable. `createGzipPayloadCodec` writes `{ "$dee_codec": "gzip", "data" }`, and `composePayloadCodecs` chains them. A codec returns a value that is not its envelope unchanged, so runs from before encryption was turned on stay readable.

Replays stay deterministic because the workflow always sees decoded values: a step's recorded input is compared with the input the code passes after both are decoded, never as ciphertext, since the same value encrypts differently each time.

The event store's own `Codec` (day 3) is a different seam: it turns a whole event into the stored string. `createGzipCodec` on it now writes the same gzip envelope, so it can be used with the Postgres store; it compresses the event's structure too, which SQL that reads `payload->>'stepId'` cannot see through, so prefer the payload codec.

## Reset, fork and batch operations

A run that failed on a bug is not patched in place. A reset copies its history up to a cut into a new run and lets the fixed code continue from there: the copied events already hold the results of the steps before the cut, so replay answers those steps from the history and they are not executed again. The cut has to leave the history in a state a run can continue from: it may keep a step that was scheduled but has no result (the reset enqueues it), but not a closing event, a cancellation request, or a timer, child workflow, event wait or update that is still unfinished, since the new run would wait for something that belongs to the old one. Events are copied as they are stored, so the new run carries the old payload envelopes and stays encrypted. A reset terminates the old run if it is open; a fork keeps it and can put the new run under another workflow type, which is how new code is tried on a real history from step N. The new run is linked to the old one by `reset_from_run_id` and starts its own chain.

A batch operation is itself a run, of the built-in workflow `dee.batch`. Its targets are snapshotted when it starts, so the set does not move while it works, and each target is handled in a transaction that applies the operation and marks the target done together. A worker that dies in the middle of a page leaves that target's transaction uncommitted: the step is retried by the next worker and picks up exactly the targets that are still pending, so every run is touched once. The pause between pages is a durable timer, which keeps the rate across a crash, and the workflow continues as new every 50 pages to keep its history short.

## Upgrades and open runs

A run that is open during an upgrade has nothing in memory that the upgrade could lose: what it did is in its history, and what it waits for is a row, a pending task, a timer, a step task with a later `visible_at`, or nothing at all when it waits for a signal. The new version only has to read those rows and replay those events the way the old one wrote them.

Two rules make that hold. Every event carries a format version, and an engine keeps reading the shapes that any supported release wrote (`docs/STABILITY.md`); the events of 0.1 are version 1, which is still the version 0.2 writes, so an event written by 0.1 replays in 0.2. And migrations change the tables around the events without rewriting what an event says: `0037` moved every event into a partitioned table and gave it its run's creation time, but kept its type, sequence number and payload byte for byte. A step that finished before the upgrade has its result in the history, so replay returns it and the step is not run again; a timer that came due while nothing ran fires as soon as the new timer loop starts.

What an upgrade can break is the workflow code, not the engine: if the code that replays an old history changed, the usual versioning rules apply. Replay exported histories against the new code before you upgrade (`wf replay`); `docs/UPGRADING.md` has the steps.
