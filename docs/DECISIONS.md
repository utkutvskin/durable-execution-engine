# Architecture decision records

Format: Context / Decision / Consequence. Newest entry at the bottom.

---

## ADR-0001: pnpm workspaces with a flat `packages/*` + `apps/*` layout

**Context:** the stack is fixed to pnpm workspaces (`docs/BACKLOG.md`), with five
independently publishable units: `core`, `worker`, `api`, `cli`, `ui`, plus a
non-package `examples` directory added on day 29.

**Decision:** one `pnpm-workspace.yaml` globbing `packages/*`, `apps/*` and
`examples/*`. `apps/ui` sits outside `packages/*` because it is a deployable
application, not a library other packages depend on. Packages are scoped
`@dee/*` and depend on each other via `workspace:*`.

**Consequence:** `packages/core` has no dependency on any other workspace
package, keeping it usable standalone. `worker`, `api` and `cli` depend on
`core`. Adding a new package later is a new directory plus one workspace
glob match, no config change.

---

## ADR-0002: one shared strict `tsconfig.base.json`, per-package `typecheck`

**Context:** the quality bar (`docs/BACKLOG.md`, A6) forbids `any` and
requires strict typing across every package.

**Decision:** a single `tsconfig.base.json` at the repository root carries
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
related flags. Each package's `tsconfig.json` only extends it and sets
`rootDir`/`outDir`. The root `typecheck` script runs `pnpm -r run
typecheck`, so a package cannot silently opt out of strictness.

**Consequence:** a new package's baseline is strict by default. Loosening a
flag means editing one file, visible in review, rather than drifting per
package.

---

## ADR-0003: eslint flat config with `strictTypeChecked`, `any` as an error

**Context:** A6 forbids `any` outright and requires `unknown` with
narrowing instead.

**Decision:** `eslint.config.js` uses `typescript-eslint`'s
`strictTypeChecked` and `stylisticTypeChecked` presets with
`projectService: true`, and turns `@typescript-eslint/no-explicit-any` into
an error rather than relying on convention. `eslint-config-prettier` is
applied last so formatting is prettier's job alone, never eslint's.

**Consequence:** `any` fails `pnpm run lint`, not just code review. Style
disagreements between eslint and prettier cannot happen because eslint's
stylistic rules that conflict with prettier are disabled.

---

## ADR-0004: postgres 16 only through docker compose, no embedded database

**Context:** the stack is fixed to PostgreSQL 16. Integration tests need a
real database (`docs/BACKLOG.md`, A6: "integration tests run against a real
postgres").

**Decision:** `docker-compose.yml` runs a single `postgres:16` service with
a healthcheck, configured from `.env.example`. CI starts the same image as
a GitHub Actions service container rather than a separate managed
database, so local and CI environments match.

**Consequence:** `pnpm run verify` alone (without `docker compose up -d`)
does not exercise anything that touches postgres yet, since no
database-backed code exists before day 2. From day 2 onward, integration
tests require the compose service (or an equivalent) to be running.

---

## ADR-0005: a hand-written SQL migration runner over `node-pg-migrate`

**Context:** day 2 (`docs/BACKLOG.md`) allows either "your own simple
migration runner or `node-pg-migrate`". A5 prefers writing core runtime
logic in-house and reserves third-party packages for things like
cryptography, date/time and the queue, none of which a migration runner is.

**Decision:** `packages/core/src/db/migrator.ts` is a small hand-written
runner: migrations are plain `<id>.up.sql` / `<id>.down.sql` file pairs
under `packages/core/migrations`, applied in filename order inside
individual transactions, tracked in a `schema_migrations` table.
`migrateUp`/`migrateDown` are plain functions over a `pg.Pool`, so they are
directly unit-testable without shelling out to a CLI. The only new runtime
dependency is `pg` itself, the client every approach needs regardless.
`packages/core/src/db/cli.ts` is a thin wrapper exposing `up`/`down` to
`pnpm run migrate:up` / `migrate:down`.

**Consequence:** no migration-numbering conventions or config file format
to learn beyond ours; adding a migration is adding a pair of `.sql` files.
The runner does not support down-migrations to an arbitrary target version
in one call (only `steps` most-recent, default 1) or migration name
collision checks beyond filename uniqueness; if either is needed later, it
is a small addition to `migrator.ts`, not a new dependency.

---

## ADR-0006: integration tests get a fresh Postgres schema per test file, not Testcontainers

**Context:** A6 requires integration tests to run against a real Postgres
and explicitly allows either Testcontainers or an ephemeral schema on
compose. Day 2 additionally requires that two test files running at the
same time do not see each other's data.

**Decision:** `packages/core/src/db/test-harness.ts` exposes
`createIsolatedSchema`/`createIsolatedDatabase`: each call opens one
Postgres connection, `create schema`s a fresh, randomly named schema, and
returns a `pg.Pool` whose connections default to it via the `-c
search_path=<schema>` connection option, so table-unqualified SQL is
already scoped correctly. `createIsolatedDatabase` additionally runs
`migrateUp` against that schema. `close()` drops the schema and ends both
pools. Every test file calls this once against the same running Postgres
instance (compose locally, the CI service container, or a natively
installed Postgres where Docker is unavailable) rather than starting a
throwaway container per file.

**Consequence:** test files run in true isolation from each other without
paying a container-startup cost per file, and the same Postgres instance
serves every test file in a run. This relies on a reachable Postgres
existing before `pnpm run test` runs (the compose service, CI's service
container, or an equivalent); it does not provision one itself the way
Testcontainers would.

---

## ADR-0007: optimistic concurrency via a precheck plus the unique constraint, not row locking

**Context:** day 3 requires that of two concurrent `EventStore.append` calls
with the same `expectedSeq`, exactly one succeeds and the other gets a
`ConcurrencyError`, proven with a stress test of 50 parallel attempts. The
`run_events_run_id_sequence_number_key` unique constraint from day 1's
schema already exists.

**Decision:** `append` reads the run's current max `sequence_number` inside
the same transaction as its inserts and compares it to `expectedSeq`,
rejecting immediately on a mismatch. It does not additionally take a
row lock (`select ... for update` on `workflow_runs`, an advisory lock, or
`serializable` isolation) to serialize concurrent appends to the same run.
Instead, the table's unique constraint is the final guard: two transactions
that both pass the precheck and both try to insert the same sequence
numbers cannot both commit, and the loser's unique-violation (`23505`) is
caught and re-thrown as a `ConcurrencyError`.

**Consequence:** correct behavior does not depend on an extra lock or a
non-default isolation level, only on the unique constraint that was already
part of the schema. The cost is a rolled-back transaction (and a retry, left
to the caller) on every race, rather than one transaction blocking behind
another's lock; for `v0.1`'s expected append volume, that trade favors
simplicity. A caller with a stale `expectedSeq` gets the same
`ConcurrencyError`, whether or not anyone else was appending concurrently.

---

## ADR-0008: `Codec` operates on the wire string, not on the value pg would parse for us

**Context:** day 3 asks for "a `Codec` interface for payload serialization
(v0: JSON)". `run_events.payload` is `jsonb`, and `pg` already serializes
JS objects to jsonb parameters and parses jsonb columns back to JS values
automatically, which would make a codec that operates on JS values a no-op
wrapper around behavior the driver already provides for free.

**Decision:** `Codec.encode`/`decode` convert between an event value and
its JSON *string* form (`JSON.stringify`/`JSON.parse` for `jsonCodec`).
`EventStore.append` inserts that string directly (Postgres resolves a text
parameter against a `jsonb` column the same way it resolves an untyped
string literal); `EventStore.read` selects `payload::text` explicitly so
`pg`'s automatic jsonb parsing is bypassed and the codec is the only thing
that turns the stored text back into a value.

**Consequence:** the codec is a real seam, not a formality: day 7's
compression and masking hooks are additional string-to-string
transformations on this same interface, with no change to `EventStore` or
to the column type. The cost is one explicit `::text` cast on every read
that would otherwise be unnecessary.

---

## ADR-0009: workflows and steps are registered by name, not passed as closures

**Context:** day 4 asks for `defineWorkflow`, `ctx.step()` and "a registry
for workflow and step registration". A workflow's `ctx.step()` call could
instead take the step's implementation directly as a closure argument, the
way a plain in-memory callback API would.

**Decision:** `StepRegistry` and `WorkflowRegistry` hold implementations
keyed by a `stepType`/`workflowType` string, registered once with
`register()` and looked up with `get()`. `ctx.step(stepType, input)` refers
to a step by that string, not by passing its function. `defineWorkflow`
only pairs a `workflowType` with its handler; it does not itself register
anything.

**Consequence:** a step's implementation lives in exactly one place (the
registry a worker builds at startup) rather than inside every workflow
that calls it, which is what day 5's replay engine needs: it can serve a
completed step's result from history by `stepId` without ever having to
serialize or re-create a closure. The cost is a run-time lookup failure
(`no step registered for type "..."`) instead of a compile-time error when
a workflow calls a step type that was never registered; `runWorkflowInMemory`
turns that into a `fail_run` command like any other handler error, since
from the run's perspective it is one.

---

## ADR-0010: `ctx.step()` and `ctx.sleep()` resolve immediately, with no suspension yet

**Context:** day 4's scope is explicit: "no persistence yet, everything in
memory". Day 5 ("decision loop and replay engine") is where a workflow run
stops at its first incomplete point, driven by which steps' results are
already in history.

**Decision:** `runWorkflowInMemory` runs a workflow handler straight
through: every `ctx.step()` call executes its registered step handler and
resolves with its result in the same pass, and every `ctx.sleep()` call
records a `start_timer` command and resolves without waiting. Nothing
here reads or replays a history; the command sequence a run produces is
only ever this one pass's decisions.

**Consequence:** day 4 can prove the DSL's surface and command shapes
end to end with a real multi-step example workflow, without building the
history-driven decision loop first. The cost is that this runner cannot
yet answer day 5's question ("given a partial history, produce only the
next command"); `runWorkflowInMemory` is the piece the decision loop will
wrap, not replace, once history comes in on day 5.

---

## ADR-0011: quiescence in the decision loop is detected with one `setImmediate` tick, not a tick-counting loop

**Context:** day 5's decision loop re-runs a workflow handler from the top
on every decision, serving each `ctx.step()`/`ctx.sleep()` call its result
straight out of the given history and never settling the ones history has
no result for yet. That handler is a real `async function`: its `await`
points resume on the native microtask queue, in an order this code does
not control directly. The loop has to know when that resumption has run as
far as it is going to — either the handler has settled, or it has stalled
on a step/timer with no result yet — before it can read off the commands
that decision produced. Getting this wrong is exactly the "micro-task
leak" day 5 warns about: stopping one tick early misses a command that was
one resolved `await` away, and a scheme that guesses a tick count can
leave a callback scheduled that fires after the loop has already returned
its result.

**Decision:** the loop is driven to quiescence by waiting on a single
`setImmediate` tick (`drainToQuiescence` in `decision-loop.ts`) rather than
by looping a fixed or counted number of `await Promise.resolve()` ticks.
Node performs a full microtask checkpoint — draining every microtask
queued so far and every microtask those in turn queue, to a fixed point —
before it runs the next macrotask, so one `setImmediate` boundary is
guaranteed to run a promise chain built only from already-settled
promises all the way to wherever it settles or stalls, regardless of how
many `await` points are on the way there. A step or timer with no
recorded result is served a promise created with `new Promise(() => ...)`
whose executor never calls `resolve`/`reject`, so it schedules nothing at
all: there is no leaked callback left for a later tick to fire.

**Consequence:** the loop needs exactly one drain call per decision, with
no magic retry count to tune and no risk of stopping mid-chain. The cost
is that this relies on Node's macrotask/microtask ordering guarantee
rather than a queue the code inspects directly, and it assumes a workflow
handler never itself schedules a real timer or I/O callback under replay;
day 6's forbidden-API sandbox check is what will make that assumption
enforced rather than just relied upon.

---

## ADR-0012: non-determinism is detected by comparing `ctx.step()` calls against the recorded `step_scheduled` event, not by comparing whole command sequences

**Context:** day 6 needs to catch the case where the workflow code being
replayed no longer makes the same decisions as the code that produced a
given history: a `stepId` is assigned purely from call order (`step-1`,
`step-2`, ...), so if code changes reorder, add, remove or retype a step
call, a later call can land on a `stepId` that history already has an
opinion about, and the existing decision loop would silently trust that
opinion. Catching this needs something in history for a replayed call to
be compared against; `stepScheduledEventSchema` (from day 3) recorded
only `stepId` and `input`, not `stepType`, so a step call that keeps its
input by coincidence but changes what step it actually invokes had
nothing to catch it.

**Decision:** `stepScheduledEventSchema` gains a required `stepType`
field, matching `ScheduleStepCommand`'s shape. `WorkflowContext.step()` in
`decision-loop.ts`'s replay context looks up the `step_scheduled` event
already recorded for the call's `stepId` (if any) before doing anything
else with it, and compares its `stepType` and `input` (via
`node:util`'s `isDeepStrictEqual`, not `===`, since `input` is
structured data) against the call actually being made. A mismatch throws
`NonDeterminismError` naming the `stepId` and both the expected and the
found `{ stepType, input }`. Sleep/timer calls are not compared the same
way: an in-flight or already-fired timer's `fireAt` is never recomputed
during replay (see `decision-loop.ts`), so there is nothing on that path
for a later call to disagree with; catching a workflow that changes
*whether* it sleeps at a given point at all is left to day 8's projection
and future work, not solved here.

`NonDeterminismError` and the forbidden-API sandbox's `ForbiddenApiError`
(ADR-0013) are both engine-integrity failures, not ordinary workflow
failures: `runDecisionLoop` rethrows them directly instead of folding them
into a `fail_run` command the way a genuine handler rejection is folded.
A `fail_run` command is a legitimate, expected run outcome a worker would
persist and move on from; a non-deterministic replay or a forbidden API
call means the decision itself cannot be trusted, which a caller needs to
be able to tell apart from "the workflow's business logic decided to
fail".

**Consequence:** every existing and future `step_scheduled` event needs a
`stepType`, which touched day 3's and day 5's test fixtures (event store
round-trip tests, the decision loop's hand-built histories) but not their
own "done when" criteria — those tests still prove the same optimistic
concurrency, ordering and replay behavior, just against a slightly wider
event shape. The cost is that non-determinism detection is currently
scoped to step identity and input, not to every way two decisions can
diverge (a changed sleep duration or a dropped call being the main gaps);
widening it further is deferred rather than attempted today, per day 6's
own scope.

---

## ADR-0013: the forbidden-API sandbox patches globals with a reference count, not a per-call save/restore

**Context:** day 6 needs `Date.now()`, `Math.random()` and `setTimeout()`
called directly from workflow code to raise `ForbiddenApiError` instead
of silently reading real wall-clock time, real randomness or scheduling a
real callback. The natural implementation monkey-patches those globals
for the duration of a decision and restores whatever they were before.
But `runDecisionLoop` is not guaranteed to run one at a time — day 5's own
"three consecutive replays" test already drives it with
`Promise.all([...])`, and nothing about the type signature forbids a
caller from doing the same in production. A naive save-then-restore
guard breaks under that overlap: if call A patches, call B starts before A
finishes and saves A's *patched* functions as its own "original", then
whichever of A or B finishes first restores correctly but the other then
restores the globals to the wrong (still-forbidding) functions, leaving
`Date.now()` permanently broken for every test or run that follows. This
was caught directly: adding the sandbox to `runDecisionLoop` made day 5's
existing concurrent-replay test corrupt global state for a later,
unrelated test in the same file, well after the original two decisions had
returned.

**Decision:** `sandbox.ts` captures the true system `Date.now`,
`Math.random` and `setTimeout` once, as module-level constants, at import
time (before anything has a chance to patch them). `guardAgainstForbiddenApis`
keeps a module-level `activeGuards` counter: it patches only when the
counter is at zero on entry, always increments on entry and decrements in
a `finally` on exit, and only restores the captured system functions when
the counter returns to zero. Overlapping calls share one patched/restored
pair of transitions no matter how many are in flight or in what order they
settle.

**Consequence:** `runDecisionLoop` can be called concurrently — as it
already is, in day 5's own test — without corrupting global state for
whatever runs afterward. The cost is a small piece of shared mutable
module state (the counter and the captured originals), which is safe only
because Node is single-threaded and every mutation happens synchronously
around an `await`, never inside one.

---

## ADR-0014: recorded history fixtures are plain JSON replayed through a small `workflowType` → handler map, not hand-built TypeScript values

**Context:** day 6 asks for `test/fixtures/histories/*.json` and a harness
that runs them as a batch, distinct from `decision-loop.test.ts`'s
existing hand-built `WorkflowEvent[]` histories. The point of a separate
fixture set is to exercise the same shape of data a real event store read
would hand back — plain, already-serialized JSON — rather than TypeScript
object literals that happen to satisfy `WorkflowEvent`'s types by
construction.

**Decision:** each fixture under `test/fixtures/histories/` is a JSON
document with `workflowType`, `input`, `history` (a `WorkflowEvent[]`) and
`expected` (the `DecisionResult` shape `runDecisionLoop` should produce
against it). The example workflow the fixtures were recorded against
moved out of `decision-loop.test.ts` into its own module,
`test/fixtures/workflows/ship-order.ts`, so the harness
(`test/replay-history-harness.test.ts`) can register it by name and look
it up the same way a worker would look a workflow up by `workflowType`.
The harness reads every `*.json` file in the fixtures directory at test
collection time and generates one `it` per file.

**Consequence:** adding a new recorded-history regression test is adding a
JSON file, not writing TypeScript; a fixture that starts failing after a
deliberate workflow change is a visible, per-file signal pointing at
exactly which recorded scenario needs to be re-derived. The cost is one
extra layer of indirection (the `workflowsByType` map in the harness) that
needs a new entry whenever a fixture references a workflow type that
was not covered by the previous day's `decision-loop.test.ts` examples.

---

## ADR-0015: `defineStep`'s input/output validation is bundled into the returned `StepHandler`, not into `StepRegistry`

**Context:** day 7 asks for input/output schema validation and a timeout
field on a step's contract. `StepRegistry.register(stepType, handler)`
already exists (day 4) and takes a bare `StepHandler`, with two call sites
depending on that exact shape (`run-workflow.ts` and its tests). Changing
`StepRegistry.register` to take a richer `StepDefinition` object instead
would ripple through both, for a validation concern that registration and
lookup do not otherwise need to know about.

**Decision:** `defineStep(stepType, options)` returns a `StepDefinition`
whose `handler` is `options.handler` wrapped to run `options.input?.parse()`
before it and `options.output?.parse()` after it, with `timeoutMs` (validated
to be positive, or omitted) carried alongside as plain metadata. The
returned `handler` is a drop-in `StepHandler`: `steps.register(definition.stepType,
definition.handler)` works against the same `StepRegistry` from day 4,
unchanged.

**Consequence:** a step defined with `defineStep` gets input/output
validation and a `timeoutMs` field without any other module needing to
change. The cost is that `StepRegistry` and a worker's `steps.get()` call
site still only ever see a `StepHandler`, not a `StepDefinition` — nothing
downstream can read `timeoutMs` back off a registered step yet. That is
expected: day 11 (worker process, lease and heartbeat) is what actually
enforces a step's timeout, and it is the point where `StepRegistry` (or its
caller) will need to start carrying `StepDefinition` objects through
instead of bare handlers, not before.

---

## ADR-0016: `serializeError`/`deserializeError` are a standalone module, not wired into the existing `fail_run`/`run_failed`/`step_failed` error handling

**Context:** day 7 asks for error serialization that preserves an error's
type, message and stack. `decision-loop.ts` and `run-workflow.ts` already
have their own ad hoc `{name, message}` construction and reconstruction for
`fail_run` commands and `run_failed`/`step_failed` events (days 4-6),
locked in by those days' own passing tests and fixtures
(`test/fixtures/histories/ship-order-step-failed.json` among them). Adding
`stack` to that existing shape would touch `events.ts`'s zod schemas,
`commands.ts`'s `FailRunCommand`, both reconstruction sites, and every test
or fixture that asserts an exact `error` object on those paths — none of
which day 7 actually asks to change.

**Decision:** `serializeError`/`deserializeError` (`workflow/error-serialization.ts`)
are a self-contained pair with their own `SerializedError` type
(`name`, `message`, an optional `stack`), used and tested on their own.
They are the contract a worker will call when it captures a step's thrown
error (day 9's idempotent step result recording is the first place that
actually happens), not a replacement for the engine-level run failure
bookkeeping days 4-6 already built and proved correct.

**Consequence:** today's change carries zero risk to any previous day's
"done when" criterion — no event schema, command shape or fixture changes.
The cost is a short-lived duplication: `decision-loop.ts` and
`run-workflow.ts` still build their own `{name, message}` records by hand.
Folding them onto `serializeError`/`deserializeError` (adding `stack` to
`run_failed`/`step_failed` too) is left for whichever future day next
touches that path, since `stack` is an additive, optional field and does
not need to happen today.

---

## ADR-0017: the payload size limit and compression are composable `Codec` decorators; sensitive-field masking is a separate, non-round-tripping function

**Context:** day 7 asks for a large payload limit, a compression hook on
`Codec`, and a sensitive-field masking hook. `Codec` (day 3) is already
just `{encode, decode}`; the event store depends on the interface, not on
`jsonCodec` specifically.

**Decision:** `createSizeLimitedCodec(codec, maxBytes = 1_048_576)` and
`createGzipCodec(codec)` each wrap another `Codec` and return a new one,
so a caller composes exactly the behavior it wants (for example
`createSizeLimitedCodec(createGzipCodec(jsonCodec))`) without `EventStore`
or `jsonCodec` needing to change. `maskSensitiveFields(value, fields)` is
a plain function, not a `Codec`, and is never called from an `encode`/`decode`
round trip: it returns a redacted deep copy for logging or display,
while the event store's own round trip always keeps the real value, since
a replay's determinism check depends on `ctx.step()`'s recorded input
matching exactly, not a masked approximation of it.

**Consequence:** `PayloadTooLargeError` (`event-store/errors.ts`, alongside
`ConcurrencyError`) is raised eagerly at encode time, before an oversized
payload reaches postgres, and is measured on whatever the wrapped codec
actually produces — so limiting a gzip-compressed codec's output measures
the compressed size, not the original one. The cost of keeping masking
out of the round trip is that nothing today automatically redacts a
sensitive field before it is written to the log; that is deliberate for
v0, and an at-rest encryption or redaction story, if the owner wants one
later, is a bigger decision than a hook on `Codec` and belongs in its own
day, not folded in here by default.


---

## ADR-0018: the run projection is a pure fold over the event log, persisted into the existing `workflow_runs` row

**Context:** day 8 asks for a `workflow_runs` projection with six states, a
transition table, and a `rebuildProjection` that reproduces the table from
the event log. `workflow_runs` (day 2) already exists and is referenced by
foreign keys from `run_events`, `tasks`, `timers` and `step_results`, and its
`namespace_id` is not derivable from any event.

**Decision:** the state logic is pure (`applyEventToProjection`,
`foldRunEvents`) and knows nothing about postgres. `refreshProjection`
folds only the events after the row's `last_sequence_number` onto its
stored state; `rebuildProjection` resets the projection to its initial
value and folds the whole log, both in one transaction holding a row lock.
"Rebuilt from scratch" therefore means every derived column (`status`,
`input`, `result`, `error`, `closed_at`, `last_sequence_number`) is
recomputed from the log, while the row itself and its non-derivable
columns (`id`, `namespace_id`, `workflow_type`) stay, since deleting the row
would violate the foreign key from `run_events`. Migration `0002` adds
`error` and `last_sequence_number` and a check constraint limiting `status`
to the six states. Three terminal events (`run_timed_out`, `run_cancelled`,
`run_terminated`) join the event catalog. The property test uses a small
seeded generator instead of a property-testing library, so no dependency
is added.

**Consequence:** any event after a terminal one, and any command passed to
`assertRunAcceptsCommand` for a terminal run, raises `InvalidTransitionError`
and leaves the row unchanged. Nothing calls `refreshProjection` from
`EventStore.append` yet; wiring the projection into the write path belongs
with the task queue and worker days, when something first needs to read it.

---

## ADR-0019: the task queue reuses the `tasks` table and identifies each delivery by a lease token

**Context:** day 9 asks for a queue with skip-locked dequeue, a visibility timeout, `enqueue` / `ack` / `nack` / `extend`, two task types and namespace-based queue names. The `tasks` table from day 2 already has `queue_name`, `task_type`, `state`, `visible_at` and `attempts`, but no payload and no way to tell one delivery of a task from the next.

**Decision:** migration `0003` adds `payload` and `lease_token` to `tasks` and check constraints limiting `task_type` to the two task types and `state` to `PENDING`, `LEASED` and `COMPLETED`. A dequeue picks rows that are `PENDING` or `LEASED` with `visible_at` in the past using `FOR UPDATE SKIP LOCKED`, then in the same statement marks them `LEASED`, bumps `attempts`, issues a new lease token and moves `visible_at` to now plus the visibility timeout. An expired lease therefore needs no sweeper: the task simply becomes eligible again. `ack`, `nack` and `extend` only apply when the caller's lease token is still current and report `false` otherwise; `extend` also refuses an already expired lease. "Now" comes from an injected `ClockSource`, so tests move time with a fake clock. A queue name is `namespace/queue`, built by `taskQueueName`.

**Consequence:** delivery is at least once: a consumer that is slow past its visibility timeout can see its `ack` rejected because another consumer holds the task, and its side effects may run twice. Making those effects idempotent is day 10's scope.

---

## ADR-0020: idempotent results are keyed by a logical attempt key and written in one transaction with their event

**Context:** the task queue (ADR-0019) delivers at least once, so the same step task can reach a worker several times, even concurrently. The step body may run each time, but the result must reach the event log exactly once, and a write cut off midway must leave nothing behind. The `step_results` table from day 2 had no uniqueness.

**Decision:** migration `0004` adds `attempt_key` to `step_results` with a unique constraint on `(run_id, step_id, attempt_key)`, and a `workflow_task_results` table unique on `(run_id, task_key)`. The caller chooses the key: it names the logical attempt, not the delivery, so every redelivery passes the same one. `recordStepResult` locks the run row, inserts the result row with `on conflict do nothing`, and only if the insert won appends the `step_completed` or `step_failed` event, all in one transaction; a loser reads and returns the stored outcome. The step event is appended at the run's current sequence rather than an expected one, because step results are facts whose relative order carries no meaning, and the run row lock serializes them. `recordWorkflowTaskResult` records a decision's events and its task key together, and a repeat key appends nothing; a new key with a stale `expectedSeq` still fails with `ConcurrencyError`. `EventStore.append` now shares `appendEventsOnClient` with the recorder so both use one sequence rule.

**Consequence:** step bodies are not prevented from running more than once, only their recording is. A step with external side effects still needs its own idempotency key toward the outside system. Nothing calls the recorder yet; the worker of day 11 will.

---

## ADR-0021: the worker is a poll loop over `TaskQueue` with injected timers, per-task heartbeats and a deadline-based shutdown

**Context:** day 11 asks for a worker that polls the queue, limits concurrency, keeps a long task's lease alive, backs off on an empty queue and shuts down gracefully. Tests must not sleep, and `@dee/core` resolves to a `dist` directory that does not exist before a build.

**Decision:** `createWorker` takes a `TaskQueue`, a handler and a `Timers` object (`setTimeout` / `clearTimeout`), so tests drive poll waits, heartbeats and the shutdown deadline with a virtual clock. The loop dequeues at most the number of free slots, doubles its wait after each empty poll up to `maxPollIntervalMs`, and resets it when a poll finds work. Each running task owns a heartbeat timer that calls `extend` every `heartbeatIntervalMs` (which must be shorter than the visibility timeout); when `extend` reports the lease gone, the task's `AbortSignal` is aborted with a `LeaseLostError` and the worker neither acks nor nacks. A handler that resolves is acked, one that throws is nacked. `stop` takes no new tasks, nacks any task a dequeue returned too late, waits for running tasks up to `shutdownTimeoutMs`, then aborts the rest with a `ShutdownTimeoutError` and nacks them so they are redelivered at once. `installShutdownHandlers` wires `SIGTERM` and `SIGINT` to `stop` and exits with 0, or 1 if tasks were dropped. The worker's `tsconfig.json` maps `@dee/core` to the core sources through `paths` and `vitest.config.ts` aliases it the same way, so lint, typecheck and tests need no prior build.

**Consequence:** the worker does not yet record results; the handler decides what to do, and wiring it to the result recorder is left to the code that builds a handler. A handler that ignores its signal keeps running after its lease is lost, so its side effects can overlap with the next consumer's; the recorder's idempotency from day 10 covers the result. The worker package no longer builds on its own with `tsc -p` (sources outside its folder); producing publishable output is day 30's packaging work. A real `SIGKILL` test with a separate process belongs to day 12.

---

## ADR-0022: crash recovery is a janitor over the existing lease columns, proven with a real SIGKILL

**Context:** day 12 asks that a second worker finish the work of a worker killed with `SIGKILL` mid-step, that half-finished runs are detected, and that recovery is measurable. The queue already redelivers a task whose visibility timeout passed (ADR-0019) and the recorder already makes a repeated result harmless (ADR-0020), but nothing said which worker lost a lease, nothing returned an orphaned lease to the queue explicitly, and nothing noticed a run that had no task left at all.

**Decision:** migration `0005` adds `leased_by`, `leased_by_version`, `leased_at` and `reclaim_count` to `tasks`; `dequeue` takes an optional `workerId` and `workerVersion` and stamps them, `ack` and `nack` clear them. A `Janitor` returns every `LEASED` task past its `visible_at` to `PENDING` (counting the reclaim and naming the previous holder), and finds a stalled run: `RUNNING`, last event older than a grace period, no `PENDING` or `LEASED` task, no `PENDING` timer. Recovering a stalled run enqueues one `WORKFLOW_TASK` for it under a transaction-scoped advisory lock, so two janitors racing cannot enqueue twice. Counters live in an in-process `RecoveryMetrics`; exporting them is the metrics day's job. The worker package gets `createWorkerIdentity` and `startJanitorLoop`, which sweeps on an injected `Timers` one sweep at a time. The kill tests start the worker as a separate Node process that runs the workspace TypeScript sources through Node's built-in type stripping and a small resolve hook (`@dee/core` to its sources, `.js` to `.ts`), so no new dependency is needed. The child parks itself at a named checkpoint (before the step result, after it, after the run finished) and the test sends `SIGKILL` there. Tests do not wait for a lease to expire: the janitor and the recovery worker use a clock 120 seconds ahead of the real one. `@dee/core` exports `createPool` and the `Pool` type so the worker package does not depend on `pg` directly.

**Consequence:** a slow but alive worker can also have its lease reclaimed once its heartbeat stops arriving; its late ack is rejected and its result recording is idempotent, so the cost is a repeated step body, not a repeated result. A stalled run is only recovered by enqueuing a decision task, so the workflow task handler that replays it is still to be written; the sample flow handler used by the tests stands in for it. The advisory lock key is a fixed constant shared by all databases on the server, which is acceptable because the lock is held only for the duration of one short transaction.

---

## ADR-0023: retries are decided per attempt from the event log's attempt numbers, and exhausted steps wait in a dead letter queue

**Context:** day 13 asks for retry policies, a non-retryable error, step and workflow timeouts, attempts in the event log and a dead letter queue with a manual requeue. The queue counts deliveries (ADR-0019), but a delivery also happens when a worker crashes (ADR-0022), and a crash is not the step failing.

**Decision:** a `RetryPolicy` (initial interval, coefficient, maximum interval, maximum attempts, jitter, extra non-retryable error names) is resolved and validated by `resolveRetryPolicy`; `defineStep` takes it as `retry`. The wait after attempt `n` is `initial * coefficient ** (n - 1)` capped at the maximum, spread by the jitter fraction from an injected `RandomSource`, and never above the maximum. An error named `NonRetryableError` is never retried; the name check survives serialization. Attempt numbers come from a new `step_attempts` table (unique on run, step and attempt), not from the queue, so a crash redelivery does not use up a retry. Each failed attempt is written in one transaction to that table and to the log as `step_attempt_failed`, with the time of the next attempt or `null`. The `StepTaskProcessor` runs the step under `runWithTimeout` (a `StepTimeoutError` is an ordinary retryable failure), nacks the task with the backoff delay while attempts remain, and otherwise gives up in one of two ways. A non-retryable error appends `step_failed`, so the workflow sees the failure. Exhausted attempts append no `step_failed`: the step goes to the `dead_letters` table and the run keeps waiting on it, because exhaustion usually means an outage an operator can fix and a later `step_completed` is then still possible. `DeadLetterQueue.requeue` enqueues the step task again on its queue with an `attemptOffset` equal to the attempts already used, so the retry budget starts fresh while attempt numbers keep increasing. A workflow timeout is `enforceWorkflowTimeout`, which appends `run_timed_out` to a run whose first event is older than the timeout.

**Consequence:** nothing calls `enforceWorkflowTimeout` periodically yet and nothing declares a workflow timeout on a run; the janitor loop or the workflow task handler will. A run whose step is dead-lettered stays `RUNNING` until the entry is requeued; discarding a dead letter is not built. The recording of a final failure is a few separate transactions, so a crash between them can repeat the step body once more, which the result recorder keeps harmless.

---

## ADR-0024: durable timers fire from the database, one transaction per timer, ordered by due time

**Context:** day 14 asks for `ctx.sleep()` that survives a full shutdown, a due timer becoming a workflow task, catch-up for the time spent down, and protection against a clock that drifts or goes backwards. The decision loop already turns a sleep into a `start_timer` command and resolves it from a `timer_fired` event; nothing yet wrote the timer down or fired it.

**Decision:** a timer is a row in `timers`, unique on `(run_id, timer_id)`, with the states `PENDING`, `FIRED` and `CANCELLED`. `recordWorkflowTaskResult` inserts the row in the same transaction as the `timer_started` event, so a timer exists exactly when its event does and a redelivered task cannot create a second one. `TimerScheduler.tick` fires due timers one transaction each: it selects the earliest due `PENDING` timer with `for update skip locked`, locks the run row, appends `timer_fired` to the log, marks the timer `FIRED` and inserts a `WORKFLOW_TASK` whose `visible_at` is the timer's `fire_at`. Locking per timer keeps two schedulers from deadlocking on runs they share, and the `visible_at` choice makes the queue deliver tasks in the order the timers came due, however late the engine started. `catchUp` ticks until nothing is due; the worker's `startTimerLoop` runs it once on start and then every interval. A due timer whose run is no longer `RUNNING` is marked `CANCELLED` without an event or a task. The scheduler reads time through `createMonotonicClock`, which never serves a reading earlier than one it already served and counts the regressions, so a clock stepped backwards can only delay a timer, never fire one early or reverse a decision.

**Consequence:** all timer state lives in postgres, so a restarted engine needs nothing from the old process. A clock stepped backwards across a restart is not remembered (the high water mark is in memory), which at worst delays timers until the clock passes their due time again. Nothing starts `startTimerLoop` in a real process yet, and no handler consumes the `WORKFLOW_TASK` it enqueues: the real worker entry point is a later day. Timers of a run that ends while they are pending are only closed when they come due.

---

## ADR-0025: cron schedules are rows in postgres with a hand-written cron parser and a trigger ledger

**Context:** day 15 asks for recurring workflows: cron expressions, time zones, three overlap policies, pause and resume, and backfill. No cron or date library is installed, and the runtime logic is meant to be written in house.

**Decision:** `parseCron` and `nextCronTime` (no dependency) handle five fields with lists, ranges, steps, month and day names, `@daily` style macros and the usual rule that a restricted day of month and a restricted day of week match either. Time zones use the built-in `Intl.DateTimeFormat`: the search walks forward in whole minutes and jumps a day, an hour or a minute depending on which field fails, reading the local fields of each candidate instant. A local time that does not exist on a spring forward day never matches, so that day has no run at that time; a repeated local time on a fall back day matches both occurrences. A schedule is a row in `schedules` with `next_fire_at`. `ScheduleManager.tick` handles one due trigger per transaction under `for update skip locked`, so concurrent ticks never handle a trigger twice and a restarted engine continues from the stored `next_fire_at`, starting every trigger it missed in order. Every handled trigger is written to `schedule_triggers` (unique on schedule and scheduled time) with the outcome `STARTED`, `SKIPPED` or `BUFFERED`; the table is what makes backfill repeatable. Overlap is decided by whether the schedule has a `RUNNING` run (`workflow_runs.schedule_id`): `skip` records a skipped trigger, `buffer_one` keeps the latest overlapping trigger in `schedules.buffered_for` (the one it replaces becomes `SKIPPED`) and a later tick starts it once no run is open, `allow_all` always starts. A started run is a `workflow_runs` row, a `run_started` event and a `WORKFLOW_TASK` in one transaction. Pausing stops everything, including the buffered trigger; resuming computes the next match from now and does not make up the pause, because `backfill(id, from, to)` is the explicit way to start past triggers (it applies the same overlap policy). The scheduler reads time through the monotonic clock of ADR-0024.

**Consequence:** a long outage starts every missed trigger, which under `allow_all` can be a lot of runs; an operator who does not want that uses `skip` or `buffer_one`. The fall back duplicate means a job pinned to a repeated local hour runs twice that night. `startScheduleLoop` exists in the worker package but nothing starts it in a real process yet, and no handler consumes the workflow task of a started run: the real worker entry point is a later day. Deleting a schedule is not built.

---

## ADR-0026: signals are history events consumed by position, select reads history order, queries replay without writing

**Context:** day 16 asks for signals that are not lost when they arrive early, a first-completed wait across branches that replays identically, and queries that never touch the event log.

**Decision:** a signal is a `signal_received` event (name and payload) appended by `signalRun` together with a `WORKFLOW_TASK` in one transaction, under the run row lock so concurrent signals get consecutive sequence numbers. The nth `ctx.waitForSignal(name)` call consumes the nth `signal_received` event of that name, so buffering needs no extra state: an early signal is simply already in the history when the wait begins. `ctx.select(branches)` takes the promises of `ctx.step()`, `ctx.sleep()` and `ctx.waitForSignal()` and picks the one whose completing event sits earliest in the history, so the winner depends on recorded order and never on timing. `ctx.setQueryHandler(name, fn)` registers a reader; `queryRun` replays the workflow over the current history with the same guard as a decision, discards the discovered commands and calls the handler registered by the point the replay stopped. Signals to a run that is not `RUNNING` are rejected with `RunNotOpenError`.

**Consequence:** a `waitForSignal` that loses a `select` still consumes its signal by position, so the workflow must not wait on the same name again expecting that signal back. There is no signal deduplication key: a client that retries a send records the signal twice. Query handlers are synchronous reads and a query always replays the whole history, which costs as much as a decision. Nothing serves `signalRun` or `queryRun` over HTTP yet and no handler consumes the `WORKFLOW_TASK` a signal enqueues: the API and the real worker entry point are later days.

---

## ADR-0027: cancellation is a history event the workflow sees at its next wait, compensations run inside the replay, termination bypasses the workflow

**Context:** day 17 asks for graceful cancellation with compensation, a hard terminate, waiting for the running step, and no new step after cancellation. The run states `CANCELLED` and `TERMINATED` and their events already existed (ADR-0018); nothing requested a cancellation or let a workflow react to one.

**Decision:** `cancelRun` appends `cancel_requested` and a `WORKFLOW_TASK` in one transaction under the run row lock; the run stays `RUNNING`. Asking twice writes nothing. During replay, once the history holds `cancel_requested`, a `ctx.step()` that was never scheduled, a `ctx.sleep()` and a `ctx.waitForSignal()` that have not completed reject with `CancelledError`, and a step that is already scheduled is waited for and resolves normally. `ctx.onCancel(handler)` registers a compensation; the handler receives a second context that keeps scheduling steps, timers and signal waits (sharing the step and timer counters, so ids stay deterministic). When the main handler has settled, or has nothing in flight, the compensations run one at a time in reverse registration order inside the same replay, so a compensation is an ordinary replayed code path with ordinary step ids. A compensation that throws is skipped; a `NonDeterminismError` or `ForbiddenApiError` from one still fails the decision. The decision is `suspended` until every compensation has finished, then `cancelled` with a `cancel_run` command, which is recorded as `run_cancelled`. `terminateRun` appends `run_terminated` directly, with no workflow involvement, and is allowed while a cancellation is pending. Both closing events go through `closeRunIfTerminal`, which brings the projection up to date in the same transaction and marks the run's `PENDING` tasks `COMPLETED`. `recordWorkflowTaskResult` and `recordStepResult` discard their input for a run that is already closed (`recorded: false`), which is what keeps a step from being scheduled or recorded after cancellation or termination.

**Consequence:** a cancellation takes effect at the workflow's next wait, not in the middle of a step; a step that never finishes holds the cancellation until its retries end, so `terminateRun` is the escape hatch. A workflow that catches `CancelledError` and keeps going is still cancelled, and its further calls reject. Once cancellation is requested the run cannot complete, even if the last step finished after the request. Tasks already leased by a worker are not withdrawn; their results are discarded. Pending timers of a closed run are closed by the scheduler when they come due (ADR-0024). Cancellation of child workflows is day 18. Nothing serves `cancelRun` or `terminateRun` over HTTP yet and no handler turns the `WORKFLOW_TASK` into a decision: the API and the real worker entry point are later days.
