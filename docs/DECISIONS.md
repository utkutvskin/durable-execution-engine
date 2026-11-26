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
its JSON _string_ form (`JSON.stringify`/`JSON.parse` for `jsonCodec`).
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
_whether_ it sleeps at a given point at all is left to day 8's projection
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
finishes and saves A's _patched_ functions as its own "original", then
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

---

## ADR-0028: children are runs linked by `parent_run_id`, closed in the same transaction that settles the parent, with parent-first locking

**Context:** day 18 asks for child workflows, a parent close policy, deterministic parallel execution, and an upper bound with backpressure. A child must start exactly once, report back to its parent without a separate process, and be cancelled or left alone when the parent closes.

**Decision:** `ctx.startChild()` assigns `child-N` from call order and yields a `start_child` command, recorded as a `child_started` event. `recordWorkflowTaskResult` creates the child in the same transaction: a `workflow_runs` row (`parent_run_id`, `parent_child_id`, `parent_close_policy`, unique per parent and child id), its `run_started` event and a `WORKFLOW_TASK`, so a redelivered task creates it once. The recorder needs a `queueName` option for that. When a child run closes, `closeRunIfTerminal` appends `child_completed` or `child_failed` to the parent (timed out, cancelled and terminated children become a `child_failed` with a named error) and enqueues a parent `WORKFLOW_TASK`, unless the parent is already closed. When a run closes, the same function applies each open child's policy: `cancel` records `cancel_requested` on the child, `terminate` closes it at once and recurses, `abandon` does nothing. The default is `cancel`. Every path that closes a run locks the parent row before the run row (`lockRunWithParent`), and a cascade only goes parent to child, so a child closing while its parent closes cannot deadlock. `ctx.all(tasks, { concurrency })` and `ctx.allSettled` take functions that return the promise of a step or child as it is. Waiting uses the position of each completion in the history, as `ctx.select` does, so with a concurrency limit the next task starts when the earliest-recorded one finished, and replay starts the same tasks the original run did. Past the limit of 1000 children per run (`maxChildren`) `startChild` throws `ChildLimitExceededError` and the run fails; `concurrency` is the backpressure. Once cancellation is requested, a child that has not started is not started and an unfinished child wait rejects with `CancelledError`.

**Consequence:** a task that wraps its promise in an `async` function loses the history position, so `ctx.all` would wait forever; the contract is documented on `ParallelTask`. Children are cancelled when the parent closes (after its compensations), not when the cancellation is requested. A `terminate` child whose own children use `cancel` only gets `cancel_requested` on them, since cancellation needs a workflow task. Nothing consumes the child's first `WORKFLOW_TASK` or the parent's `child_closed` task yet: the worker entry point is a later day. There is no per-parent limit on open children besides `concurrency`, and no limit on depth.

---

## ADR-0029: continue-as-new is a closing event that creates the next run of a chain, and only closed runs are pruned

**Context:** day 19 asks for workflows that run forever without their history growing, a way to query a whole run chain, a threshold warning, and snapshots with pruning under a retention policy. The decision loop replays a run from its first event, so any event of an open run is needed until the run closes.

**Decision:** `ctx.continueAsNew(input)` records the request and returns a promise that never settles, so the intended use is `return ctx.continueAsNew(input)`. The decision is `continued_as_new` with one `continue_as_new` command; steps, timers and children the same decision discovered are dropped. After a cancellation request the call rejects with `CancelledError`. The command is recorded as `run_continued_as_new`, a closing event that moves the run to the new terminal state `CONTINUED_AS_NEW`. In the same transaction as the event, `recordWorkflowTaskResult` creates the next run: same namespace, workflow type, schedule and parent link, the event's input, `chain_index + 1`, `continued_from_run_id`, its `run_started` event and a `WORKFLOW_TASK` with reason `continue_as_new`. A trigger on `workflow_runs` sets `first_run_id` to the row's own id on insert, and continued runs copy it, so a chain is read with one `first_run_id` (`readRunChain`, `findCurrentRun`). A continued run keeps the parent run id but not the child id: when a child chain finally closes, the parent is notified using the first run's child id, and a `CONTINUED_AS_NEW` close notifies nobody. The parent close policy applies to the latest run of a chain because that is the open one. The open children of the run that continued get their own parent close policy applied, as for any closing run. `DecisionLoopOptions.historyWarningThreshold` adds `historyWarning` to a decision whose history holds at least that many events; it is advice, nothing fails. The compactor writes a `run_snapshots` row (the projection folded up to a cut sequence) and deletes the events up to it, for closed runs that closed at least `closedRunRetentionMs` before the clock's now, keeping the last `tailEvents` events. `rebuildProjection` starts from the snapshot, and the sequence check of an append also counts the snapshot, so a pruned run cannot restart its sequence at one.

**Consequence:** the 10,000 iteration test proves a constant history size (one batch plus the start event) by driving the decision loop and counting events; it does not measure heap use, which stays a property of holding one history at a time. Open runs are never pruned, so a workflow that does not continue as new still grows without bound; the warning is how it learns to. `run_events` is no longer strictly append-only for closed runs: only the compactor deletes, and only behind a snapshot. A snapshot does not keep step results or the event list, so a pruned run cannot be queried or replayed as a workflow, only read as a projection; `step_results` and the other tables are not pruned. Signals, queries and cancellations address a run id, so a client holding only the first run id resolves the open run with `findCurrentRun` first. Nothing calls the compactor in a running process yet: a loop around `sweep` belongs to the worker entry point, a later day.

---

## ADR-0030: sticky execution keeps a live workflow per run in a worker cache and routes workflow tasks by a claim table

**Context:** day 20 asks that a worker not replay a run from scratch on every task, that the same run reach the same worker, and that a miss, an expiry or a flush never change the outcome. The decision loop is a pure replay: it holds no state between calls, so there was nothing to cache.

**Decision:** `createLiveSession` keeps one workflow execution alive. Its first `advance(history)` replays the whole history; later calls feed only the events recorded since, resolving the waits that were suspended, so the handler is not run from the top again. A session is a pure function of the events it has been fed, so a stale session advanced with a longer history decides what a full replay would. `createStickyDecider` holds the sessions in a per-worker `RunCache` (least recently used, bounded by `maxRuns`, entries idle longer than `stickyTimeoutMs` count as gone). Every case a session cannot answer falls back to `runDecisionLoop`: no entry, an expired or flushed one, a history that does not continue what the session saw, commands of the previous decision that never appear as `step_scheduled` or `timer_started` events (the recording failed), and a workflow that uses children, `ctx.all`, `ctx.allSettled`, `ctx.select`, `ctx.onCancel` or `ctx.continueAsNew` (the handler is then remembered as uncacheable). A decision that closes the run and any thrown error drop the session. Routing is a table `run_stickiness (run_id, worker_id, expires_at)` written by `createStickyRouter.claim` after a worker leaves a run suspended. `TaskQueue.dequeue` with `stickyFor` skips `WORKFLOW_TASK`s of runs that another worker holds a live claim on; once `expires_at` passes, any worker takes the task and replays. Step tasks are never held back. The routing lives in the dequeue query instead of a second queue per worker, so none of the places that enqueue a workflow task changed.

**Consequence:** with the cache on, a 500 step run replays once instead of 501 times; the benchmark test asserts at least 80 percent fewer full replays and the same final decision. Workflows that use the unsupported features replay on every task as before. A session resolves concurrently pending waits in history order while a full replay resolves them in creation order, so a handler that interleaves `ctx` calls between natively awaited promises could differ; such a handler should use `ctx.select` or `ctx.all`, which are replayed anyway. Sessions hold the handler's closure state in memory, so the cache size is the memory bound. Nothing calls `claim`, `releaseWorker` or the decider in a running process yet: no handler consumes the `WORKFLOW_TASK`, the real worker entry point is a later day. Cache invalidation on a version change (day 21) must flush the cache or key it by build id.

---

## ADR-0031: patch gates decide from the command count of the history and are refused by build when the history is newer than the code

**Context:** day 21 asks that runs which started on version 1 of a workflow finish on version 2 without a `NonDeterminismError`, that new runs take version 2, that patch decisions be in the event log, that the worker build be stamped, and that a version mismatch be rejected safely. The decision loop replays the code over the whole history, so the code cannot tell on its own whether a run reached a given line on older code.

**Decision:** `ctx.patched(id)` compares the number of commands (steps, timers, children) the replay has issued so far with the number of `step_scheduled`, `timer_started` and `child_started` events in the history. A recorded `patch_recorded` event for the id answers `true`. Otherwise, fewer issued commands than recorded ones means the history went past this point on older code and the answer is `false`. Otherwise the run is at the frontier: the answer is `true` and a `record_patch` command, recorded as `patch_recorded`, is added to the decision. The first answer for an id is kept for the rest of the replay. `ctx.deprecatePatch(id)` takes the same decision without returning it. `DecisionLoopOptions.buildId` is stamped on the event. After a replay, a `patch_recorded` event for an id that the code never consulted raises `VersionMismatchError`, an integrity error rethrown like `NonDeterminismError`, from both `runDecisionLoop` and `runQuery`. A live session reports `patched` and `deprecatePatch` as unsupported, so the sticky decider replays such workflows in full. The cache is held in one worker process, which runs one build, so it needs no key by build id.

**Consequence:** a run suspended on a signal or timer at the gate takes the new branch when it resumes, which is safe because the old code had not passed the gate either. A change visible only through signal consumption or `ctx.now()` cannot be gated because those leave no command in the history. Removing a `deprecatePatch` call while an open run still holds its marker makes every worker refuse that run, so the guide in `docs/VERSIONING.md` orders the steps. Workflows with patches do not benefit from the sticky cache. Nothing nacks a refused task yet: no handler consumes the `WORKFLOW_TASK`, the worker entry point is a later day. The `buildId` is not persisted on the run row, only on patch events.

---

## ADR-0032: the api is a hand written node http layer over one route table, and every query takes the namespace from the api key

**Context:** day 22 asks for seven endpoints, api key authentication, namespace isolation with a mandatory tenant filter, an idempotency key for start, and an OpenAPI document that passes schema validation. Nothing in the engine knew about callers yet; `RunInteractions` and `RunControl` address a run by id alone.

**Decision:** the package `@dee/api` uses `node:http` and `zod`, which the core already depends on, and no web framework. Each endpoint is one entry of a route table that holds its method, path template, zod request schemas, response schemas and handler, so the OpenAPI 3.1 document is generated from the same objects the server validates with and cannot drift. API keys are random 192 bit secrets with a `dee_` prefix; `api_keys` stores only their sha256 hash, a revoked key has `revoked_at` set. The namespace is read from the authenticated key and passed as the first argument of every `RunService` method; no request body, query or header can name a namespace. Reads filter on `namespace_id` in the query itself. The commands that already exist in the core (`signalRun`, `cancelRun`, `terminateRun`) are preceded by an ownership check on `(id, namespace_id)`, safe without a lock because a run's namespace never changes. A run of another namespace and a malformed run id both raise `RunNotFoundError` and answer the same 404, so a caller cannot learn that an id exists elsewhere. The idempotency key is the `Idempotency-Key` header, stored in `workflow_runs.idempotency_key` under a partial unique index on `(namespace_id, idempotency_key)`. The start insert uses `on conflict do nothing`, so concurrent starts serialize on the index and exactly one creates the run, its `run_started` event and its `WORKFLOW_TASK` in one transaction. A repeat with the same workflow type and input returns the run with 200, a repeat that differs answers 409. Lists use keyset pagination on `(started_at, id)` with an opaque cursor that carries the timestamp at microsecond precision. OpenAPI validity is checked by `validateOpenApiDocument`, a structural validator written for the rules the generated document relies on, instead of a third party parser.

**Consequence:** no framework means no middleware ecosystem; rate limits and quotas on day 23 are added around `createApiHandler`. The validator covers the OpenAPI constructs this document uses, not the whole specification, so a feature added later (callbacks, discriminators) needs a rule before it is trusted. The keys of two namespaces cannot collide on an idempotency key. An idempotency key never expires. Nothing creates namespaces or keys over HTTP: `ApiKeyStore.issue` is the only way, an admin surface is not built. The workflow task a start enqueues is not consumed by any handler yet, as for signals and cancellations.

## ADR-0033: quotas are enforced in front of the route table, the rate limiter is in memory, and a task that loses its lease three times is quarantined

**Context:** day 23 asks that one namespace cannot starve another: a per-namespace rate limit, concurrent run and pending task quotas, `429` with `Retry-After`, backpressure on worker polling, and protection against a task that kills every worker that takes it.

**Decision:** limits are rows in `namespace_quotas` (migration 0013), read on each request, so a change applies at once and survives restarts. `createQuotaGuard` runs in `createApiHandler` after authentication and method matching and before the body is read, with three request kinds: reads spend only rate limit tokens, writes are also checked against the pending task quota and the queue depth, and `startRun` against the concurrent run quota. The rate limit is a token bucket per namespace kept in process memory and driven by an injected clock. Usage is measured with `count(*)` queries on `workflow_runs` and `tasks`. A global `maxQueueDepth` answers writes with 503 instead of 429, because it is the service and not the caller that is over its limit. Poison pill protection is in the janitor: `reclaim_count` already counts lost leases, and when the reclaim that would make it reach `poisonThreshold` (default 3) runs, the task becomes `QUARANTINED` (migration 0014), a state the dequeue query never selects. A quarantined task counts as open work in the stalled run check, so the janitor does not enqueue replacement tasks for it. Worker backpressure is an optional `pollBudget` callback; `createDepthBackpressure` derives the budget from the queue depth between a low and a high watermark.

**Consequence:** the checks of usage and the insert are separate statements, so concurrent writes can overshoot a quota by the number of requests in flight; the quotas are limits on load, not an invariant. A start repeated with an existing idempotency key is counted like a new start. Each request costs one quota query, plus a usage query when a count limit is set; caching the quota is possible later at the price of a delay in applying changes. The token bucket is per api process, so several processes multiply the allowed rate. Quarantined tasks are not retried automatically: an operator releases them, and the run they belong to waits until then. A slow but healthy worker that keeps losing its lease also reaches the threshold; the lease length and the heartbeat decide how likely that is. The threshold counts lease losses, not handler exceptions, which retry policies already cover.

---

## ADR-0034: the trace context is stored on the run, spans are emitted where work happens, and replay emits none

**Context:** day 24 asks for one span tree per run across the start call, workers and child workflows, spans for steps and timers, no spans from replay, and a sampling setting. A run lives for days and is handled by many processes, so no span can stay open in one of them for the life of the run.

**Decision:** the API only needs `@opentelemetry/api`; the core also depends on `@opentelemetry/sdk-trace-base`, `@opentelemetry/resources` and `@opentelemetry/exporter-trace-otlp-http` for `createTracingProvider`. The context is a W3C `traceparent` string in `workflow_runs.traceparent` (migration 0015), parsed and formatted by the engine itself. The first span of a run (`workflow.start`, `workflow.schedule` or `workflow.child`) is a short span that owns the context, and every later span of the run is its child; a run therefore has no long lived workflow span. Child runs get the context of a `workflow.child` span under the parent's context, and continue-as-new copies the context. Spans are emitted by the code that does the work: the step task processor around each executed attempt, the timer scheduler when a timer fires (backdated to the timer's creation), and the result recorder after each recorded workflow task. The decision loop is never given a `Tracing`, which is what keeps replay free of spans. Spans whose context is stored in a transaction are started inside it and ended after the commit, so a rollback leaves them unended and unexported. `Tracing` is an interface with a no-op default, so every component works unchanged without OpenTelemetry configured. Sampling uses a parent based sampler with a trace id ratio root: the decision is made when the trace starts and travels in the `traceparent` flags.

**Consequence:** a trace has no span that covers the whole run; its duration is read from the span times. A workflow task or step attempt that crashes after the work but before the commit leaves no span, and one that is redelivered after a crash that happened after the commit is not traced twice. A step body that really runs twice (a crash redelivery) has two step spans, which is accurate. Spans of an unsampled trace are never created, but the `traceparent` is still stored. The compose file starts Jaeger, which could not be run in the environment that built this day: the span tree is verified against an in-memory exporter, and the OTLP exporter and Jaeger are not exercised by a test. Nothing creates a provider in a running process yet because the worker and API entry points are a later day.

---

## ADR-0035: metrics are rendered by an in-house registry that reads Postgres on scrape, and the probes sit outside authentication

**Context:** day 25 asks for eight Prometheus metrics, json logs with correlation ids, `/health` and `/ready`, and a dashboard. Workers and the api are separate processes, and most of what an operator wants to see (queue depth, run states, timer lag) already lives in Postgres.

**Decision:** a small registry (`createMetricsRegistry`) renders the text format 0.0.4 itself instead of adding `prom-client`: counters, gauges and histograms with labels are about 150 lines, and the repository tests the output with a strict parser. `createEngineMetrics` registers a `beforeRender` hook that queries Postgres, so depth, timer lag, active workers, run counts, retried attempts and quarantined tasks are fleet wide whichever process is scraped. Only task latency, which has no durable record, is observed in process: the worker reports each settled task through `onTaskSettled`, measured from `visible_at` so queue wait is included. The retry count is mirrored with `Counter.set` from `step_attempts`, which makes it survive restarts. Logs are one json line per call; the correlation id travels in `AsyncLocalStorage`, so code under a request needs no extra argument. `/health`, `/ready` and `/metrics` are answered before authentication.

**Consequence:** a scrape costs six small queries, and an unauthenticated `/metrics` exposes counts, so it belongs on a private network. `dee_step_retries_total` counts rows in `step_attempts`, so history compaction or cleanup that deletes them would make it fall. `dee_leases_reclaimed_total` and the latency histogram reset when the process restarts. The queue depth counts all queues in the database, not only the one the api serves. Nothing starts a metrics server in a worker process or passes `onTaskSettled` in a running process yet, since the entry points are a later day, and no Prometheus or Grafana service is in the compose file.

---

## ADR-0036: the ui is typed browser modules served by the api process, and the run stream polls the database

**Context:** day 26 asks for a run explorer with filters, a timeline, viewers, live updates over SSE, signal, cancel and dead letter requeue, proven end to end in a browser. The repository has no bundler and the stack is fixed.

**Decision:** the client is written in TypeScript under `apps/ui/src/client`, typechecked with the DOM library in its own project, and served as plain JavaScript by `createUiHandler`, which strips the types at start with `module.stripTypeScriptTypes` (Node 22.13 and later, erasable syntax only). No framework: elements are built by a small `h` helper that only creates text nodes, so run data cannot inject markup. The ui is mounted on the api's origin through the new `sideHandler` option. The api key is entered by the user and read from `sessionStorage`; requests carry it as a bearer token, so the stream is read with `fetch` and not `EventSource`, which cannot set headers. The stream is a handler of its own and not a `Route`: a route returns one body, and the OpenAPI document describes request and response pairs. It polls `run_events` every `streamPollMs` instead of using `LISTEN/NOTIFY`, because that needs no change to the event store and works through any connection pooler. The api gets the endpoints the ui needs: `startedAfter` and `startedBefore` on the list, `GET /v1/namespace`, and dead letter list and requeue scoped to the namespace. `playwright-core` is added as a root dev dependency without a browser download; the test uses the Chromium that is installed on the machine. The api handler now takes its timers and clocks from `node:timers` and `node:perf_hooks`, and `createPool` accepts `idleTimeoutMillis`, because the end to end test hosts the api and the workflow decisions in one process and the decisions patch the global `setTimeout`.

**Consequence:** a stream costs one indexed query per run per poll interval while it is open; many open run pages multiply that. The first event after a change arrives after up to `streamPollMs`. The ui source needs a Node that has `stripTypeScriptTypes`, and the experimental warning of that function may be printed on start. The end to end test depends on a Chromium binary being present and fails, not skips, without it. A workflow decision still patches process globals; hosting workers and the api in one process is only safe with the measures above, and the entry points of a later day should keep them apart or reuse these measures.

---

## ADR-0037: chaos faults are injected in front of Postgres, and the invariant checker only reads

**Context:** day 27 asks for six failure scenarios of ten repetitions each with zero invariant violations. The environment has no Docker daemon and no way to restart or throttle the Postgres under test, so faults that need control of the server cannot be produced directly.

**Decision:** the faults sit between the engine and Postgres. A TCP proxy (`startFaultProxy`) severs connections, refuses reconnects, adds latency and lets a commit execute while swallowing its answer. A pool wrapper (`createSlowDiskPool`) delays write statements. The clock is the injected `ClockSource` that every component already reads. Worker kills use the existing `SIGKILL` harness. Every repetition is seeded, runs against its own queue name in a shared migrated schema, and ends with `createInvariantChecker` scoped to the runs and tasks the repetition created. The checker only reads and takes no locks. A repetition is also a violation when its workload does not converge, when a run ends with the wrong result, when no fault was injected, or when the harness itself throws, so a broken harness cannot pass as a clean run. The invariant that a running run must have something to wait for treats a run parked on a signal as stalled; the suite therefore uses workloads that never park on signals.

**Consequence:** the suite proves the engine survives broken connections, late and duplicated deliveries, slow writes and moved clocks, but not a restarted server, a real fsync stall or a lost network between hosts. The suite found two real defects, both fixed the same day. `refreshProjection` and `rebuildProjection` held a pooled connection and its row lock while reading events through the same pool, which deadlocks once as many calls run at once as the pool has connections; events are now read before the lock is taken and the fold is retried when the stored position moved. `createPool` left the `error` event of a connection that died between statements unhandled, which ends the process; it now takes an `onError` callback and always listens. A connection that died while held is still returned to the pool by `client.release()` and fails the next statement once before the pool drops it (see `docs/DEFERRED.md`).

---

## ADR-0038: events are appended with one statement, and the hot query indexes are partial and ordered

**Context:** day 28 asks for baseline figures, at least one bottleneck found and fixed with a before and after number, an index review backed by `EXPLAIN ANALYZE`, and batching of event writes. A profile of the benchmark process showed it bound by the number of statements it sends, not by the work Postgres does for them.

**Decision:** `appendEventsOnClient` writes all events of an append with a single `insert ... select from unnest(...)` and maps the returned rows back to their sequence numbers, so the ordering of the returned rows does not matter. Migration `0016_hot_query_indexes` replaces `tasks_queue_dequeue_idx` with `tasks_queue_order_idx (queue_name, visible_at, created_at, id)` so the dequeue reads in index order, and adds two partial indexes, `workflow_runs_open_idx` on open runs and `tasks_open_run_idx` on the open tasks of a run, for the janitor's stalled run scan. The benchmark harness and the plan checks live in `packages/worker/src/bench/` and run through `pnpm run bench` and `pnpm run bench:explain`. No new dependency.

**Consequence:** the optimistic concurrency rules are unchanged: the sequence check and the unique constraint still decide. An append of one event gains nothing, and the end-to-end throughput of the saturated benchmark did not move; it is limited by the roughly 47 statements a run costs (`docs/BENCHMARKS.md`). The three new or changed indexes add write cost to `tasks` and `workflow_runs`; they are partial, so they only hold open rows. A failing plan test (`hot-queries.integration.test.ts`) now guards the dequeue and the stalled run scan against losing their indexes. The planner choices were checked on PostgreSQL 16 with 20,000 to 100,000 seeded runs; another version or very different data could plan differently.

---

## ADR-0039: one engine runtime drives workflow and step tasks, the sandbox guards only the decision's call chain, and the cli runs the sources directly

**Context:** day 29 asks for `wf dev`, `wf worker` and two examples that run end to end. Until now nothing consumed a `WORKFLOW_TASK`: the tests played the worker by hand. A process that runs the api, a worker and the steps of an example together also hit the rule from ADR-0036: a workflow decision patched `Date.now`, `Math.random` and `setTimeout` for the whole process while it ran, so a step that read the clock at that moment, or any other code in the process, failed with `ForbiddenApiError`.

**Decision:** `createEngineTaskHandler` and `startEngine` (in `packages/worker/src/engine`) are the missing consumer. A workflow task reads the history, decides it through the sticky decider, records the decision with the task id as task key, and then makes sure every scheduled step without a result has a `STEP_TASK`, checked under a per run advisory lock; because that check runs on every workflow task, a step task lost between the record and the enqueue is recreated by the next task, including the one the janitor enqueues for a stalled run. A step task runs through the step task processor and enqueues a workflow task when the step reached a result. A workflow task that decided from a history another writer has since extended records nothing and reports `superseded`: every writer enqueues its own workflow task, which reads the whole history. `startEngine` adds the timer, schedule and janitor loops. Workflow and step tasks share one queue. `guardAgainstForbiddenApis` now refuses the three globals only inside its own `AsyncLocalStorage` context, so the patch can stay installed while other code in the process runs. The cli resolves `@dee/*` to the source entries with a resolve hook, as the chaos harness already does, and `bin/wf.js` registers it before importing `main`; there is no build step and no new dependency (the cli uses `node:util` `parseArgs`). The examples keep their external system behind an interface and are loaded by the cli through their package entry.

**Consequence:** a decision's call chain is the only place the globals are forbidden, so a promise created inside workflow code and settled elsewhere still carries the context; code that escapes the chain (a native callback that does not propagate async context) could call the real functions unnoticed. A crash between recording a decision and enqueueing its step tasks leaves the step waiting until a later workflow task of the run arrives, which the janitor's stalled run recovery sends after its grace period (60 seconds in `startEngine` by default); the advisory lock only keeps two workflow tasks of one run from enqueueing the same step task twice. A step can still run twice, after a crash or a lost lease, so steps must be safe to run twice, as `docs/EXAMPLES.md` says. `wf` needs Node 22.18 or newer for type stripping and is not yet packaged as a published bundle (day 30). `wf dev` issues a new api key on every start and keeps the earlier ones valid.

---

## ADR-0040: the image runs the sources with type stripping, and the release is a tag and a changelog

**Context:** day 30 asks for a multi-stage Dockerfile, a published image, a changelog, the `v0.1.0` tag and a release note. The cli and every package run as TypeScript through Node's type stripping and workspace links (ADR-0039); there is no build output to copy. The sessions that build this repository have no Docker daemon and no registry credentials.

**Decision:** the Dockerfile has a base stage (Node 22 and pnpm through corepack), a build stage that installs the production dependencies from the frozen lockfile and removes tests, docs and workflows, and a runtime stage that copies the result, runs as the `node` user and starts `wf dev` listening on all interfaces. No compile step is added just for the image. All workspace packages move to version 0.1.0 together. The release is the annotated tag `v0.1.0` on the commit that carries the changelog entry, and the changelog entry is the release note. A test (`test/release/release.test.ts`) keeps the versions, the changelog, the Dockerfile and the documentation links consistent, and the `docker` job in CI builds the image and starts it against a Postgres service. The image is not pushed to a registry in v0.1.0.

**Consequence:** the image needs Node 22.18 or newer, which the `node:22-slim` tag provides, and starts a little slower than compiled output because Node strips types at load. Anyone who wants the image in a registry builds and pushes it themselves. The Dockerfile was not built in the session that wrote it; its steps were reproduced by hand (a production install from the lockfile, tests removed, `wf dev` started and a payment saga run to `COMPLETED`), and the first CI run of the `docker` job is the real build. A registry push on tags and a package build are on the roadmap.

---

## ADR-0041: the project is licensed under Apache-2.0

**Context:** every package said `UNLICENSED`, which stops anyone but the owner from using the code and makes publishing to npm pointless (`docs/REVIEW.md`, section 7). The `v0.1.0` tag had not reached `origin`, so the licence could still ship with the first release. The candidates for an infrastructure project were MIT, Apache-2.0, and source-available licences such as BSL or SSPL.

**Decision:** the owner chose the Apache License 2.0. The canonical text is in `LICENSE`, the attribution in `NOTICE`, and every `package.json` says `"license": "Apache-2.0"`. The `v0.1.0` tag is placed on the commit that adds the licence, so the first published release is already licensed.

**Consequence:** anyone may use, modify and redistribute the code, including commercially, with an explicit patent grant from contributors and a patent retaliation clause, which company legal reviews usually require of infrastructure. Redistributors must keep `LICENSE` and `NOTICE` and mark files they change. A hosted competitor may run the engine without contributing back; closing that would need a relicence, which needs every contributor's agreement. Third-party contributions are accepted under the same licence (inbound equals outbound) and no contributor licence agreement is required.

---

## ADR-0042: ctx.now is a recorded marker, ctx.random and ctx.uuid come from a seeded generator

**Context:** `ctx.now()`, `ctx.random()` and `ctx.uuid()` were read live on every replay, so a value fed into a step input raised `NonDeterminismError` on the next decision (`docs/REVIEW.md`, section 2, item 1). The backlog allows either a generator seeded by the run id and a counter, or recorded marker events.

**Decision:** `ctx.now()` is recorded. The first time a call is reached, the decision emits a `record_time` command, stored as a `time_recorded` event, holding the time of the event that triggered the decision (the `created_at` of the last event of the history the worker read; the clock source is the fallback when the caller gives none). The nth `ctx.now()` call of a replay returns the nth `time_recorded` event, so the answer cannot change. `ctx.random()` and `ctx.uuid()` are not recorded: they come from a generator whose nth value is the SHA-256 of the run id and the counter n, shared by both methods, so it needs no event and the cold replay and the live session draw the same values. A `RandomSource` passed in the decision options still overrides the generator, which keeps in-memory runs and tests with fixed values unchanged. The sources are called outside the forbidden API guard. Step inputs are compared by canonical encoding: both sides go through the default codec, are read back, and are encoded again with sorted keys.

**Consequence:** every `ctx.now()` call adds one small event to the history, which counts toward the history length and the continue-as-new warning; code that needs the time often should read it once and keep it. A run started before this change has no markers, and its first replay on new code writes them for calls it had not recorded, which is safe because those calls had no recorded value to contradict. The values of `ctx.random()` and `ctx.uuid()` depend on the order of value calls, so a code change that adds or removes a call before an existing one changes later values; such a change needs `ctx.patched()` like any other reordering. They are predictable from the run id and must not be used as secrets. A live session whose emitted marker was not recorded is dropped and replayed, like an unrecorded step.

---

## ADR-0043: replay delivers recorded results in history order and matches commands as one sequence

**Context:** a replay resolved every recorded result when the workflow code reached the call, so the order in which promises settled followed call order. Code that reacted to a signal in a `.then()` took a different branch on replay than the live run did, which then failed with `NonDeterminismError` or, worse, decided differently (`docs/REVIEW.md`, section 2, items 3 and 5). Timers were matched by id only, and recorded commands the new code no longer issued went unnoticed.

**Decision:** the cold replay and the live session start the handler first and then deliver the result events (step results, fired timers, signals, child results) one at a time in history order, draining microtasks to a fixed point after each event that settles a wait. A wait whose result event was already delivered settles when it is created. Commands are indexed from the whole history up front, so a call made while events are delivered finds the commands recorded after the event it reacts to. A `CommandMatcher` compares the commands the code issues with the commands the history recorded, by position: a step (type and canonical input), a timer (and its `durationMs`, which `timer_started` now stores), a child (type and canonical input) and a patch. Another command at a position, or recorded commands left unissued once the replay has settled, raise `NonDeterminismError`. `ctx.select` and the parallel helpers keep choosing by the history position of each branch.

**Consequence:** a replay now costs one macrotask turn per settling event instead of one per decision, which is small next to the handler work. Changing a timer duration, swapping a step for a sleep or removing a trailing step is a breaking change for open runs and needs `ctx.patched()`. A timer recorded before `durationMs` existed is compared by id only, so such runs keep replaying. The sticky session raises the same errors as the cold replay. A property test (`replay-equivalence.test.ts`, 500 generated workflows with random event orders) keeps the cold replay, the incremental session and a fresh session in agreement.

---

## ADR-0044: one terminal step result by unique index, and the step task is created with its event

**Context:** a step could record two terminal results: the duplicate check ran on `(run_id, step_id, attempt_key)`, so a slow attempt that lost its lease and a later retry both appended, and cold replay took the first result while the sticky session took the last. The `STEP_TASK` of a scheduled step was enqueued in a second transaction after the decision, so a crash between the two delayed the step by the stalled run grace, and `ensureStepTasks` held a client while `queue.enqueue` took another, which deadlocks a pool when concurrency reaches its size. Dead-lettering and the ack were two statements, and clients whose connection had died went back to the pool (`docs/REVIEW.md`, section 2 item 6 and section 3 items 5, 9 and 10).

**Decision:** `step_results` has a unique index on `(run_id, step_id)` (migration 0017, which first removes later duplicates and keeps the first row). `recordStepResult` takes the run row lock, then looks for any result of the step under any attempt key; a found result is returned with `recorded: false` and nothing is written. The step task processor trusts that check and reports `already_recorded` when its own attempt lost; its read before running a step stays as a cheap skip. `recordWorkflowTaskResult` inserts the `STEP_TASK` of every `step_scheduled` event in the transaction of the event, once per step, when the recorder has a `queueName`. `ensureStepTasks` uses the same insert on its one client. `addAndAck` stores a dead letter and acks the task in one transaction, and stores nothing when the lease is gone. `withClient` and `withTransaction` roll back on failure and destroy a client whose rollback fails; every `pool.connect()` site releases with that result. `createPool` sets a 30 second acquire timeout.

**Consequence:** the first terminal result of a step wins, even when a later attempt would have succeeded where the first failed; a failed first result that should be retried must be an attempt failure, not a terminal one. The migration deletes duplicate result rows of already damaged runs, and their events stay in the history. A pool with no free connection fails a `connect()` after 30 seconds instead of waiting forever, so a stuck pool shows up as errors. The recorder needs a `queueName` to create step tasks, so code that builds it without one must enqueue itself.

## ADR-0045: park tasks the engine cannot decide, mark waiting runs, back off recoveries

**Context:** a task whose handler threw was redelivered on every poll, because `startEngine` never set a nack delay and quarantine counted only the lease expiries the janitor saw. A task that crashed its worker was taken again by the next polling worker straight from the expired lease, so quarantine never triggered while workers polled. The stalled run check matched every run that waits on a signal, a child or a dead-lettered step, so each of those runs was replayed on every janitor sweep, forever (`docs/REVIEW.md`, section 3 items 1 to 3).

**Decision:** the worker nacks a failed task after `nackDelayFor(task.attempts)`, an exponential delay from `NackBackoff` (engine default 250 ms doubling to 30 s), and quarantines it once `task.attempts` reaches `maxHandlerAttempts` (engine default 8). `TaskQueue.quarantine` parks a leased task with a reason. `dequeue` counts taking a task whose lease expired as a reclaim and quarantines it instead of delivering it at `poisonThreshold` (default 3, shared with the janitor). `NonDeterminismError`, `VersionMismatchError` and `UnknownWorkflowError` do not fail the run: the task handler throws `ParkTaskError`, and the worker quarantines the task at once with the error as its reason. An operator deploys the matching build (or fixes the code) and releases the task with `releaseQuarantined`. Migration 0018 adds `workflow_runs.waiting_on` (`external` or `dead_letter`), `recovery_count` and `last_recovered_at`. After every recorded decision the handler marks a suspended run `external` when it has no open step, `dead_letter` when every open step has an open dead letter, and unmarked otherwise; the stalled predicate skips marked runs. Each stalled recovery of a run bumps `recovery_count`, and the next one waits `graceMs * 2^recovery_count`, capped at one hour, until a decision records events.

**Consequence:** a run is never failed because of a code or deployment error; it stays `RUNNING` with a quarantined task until an operator acts, which is visible in `listQuarantined` but not yet in the API or UI. A run marked waiting is only moved by whoever ends the wait (signal, child result, dead letter requeue, timer), so a lost enqueue on such a path is no longer healed by the janitor. `attempts` counts every delivery, not only failures, so a task that was nacked for another reason also moves closer to quarantine. A poll that parks tasks returns fewer than `limit` tasks.

## ADR-0046: runs own a queue, the database owns the lease clock, steps get an abort signal

**Context:** a run had no queue. Timers, signals, cancels, stalled recovery and schedules enqueued to the queue of the component that acted, so with two worker pools the task could land on the pool that lacks the workflow, and `close-run.ts` and `continued-run.ts` guessed the queue from the oldest task row, which can never be pruned. Lease, visibility and the extend check used the worker's wall clock, so a host running fast took live leases, and the stalled check compared a client clock with the database's `now()`. The step `AbortSignal` never reached step handlers, a failing heartbeat let the step run on with an expired lease, and a shutdown timeout nacked a task whose handler was still running. Cron catch-up fired every missed instant, and an invalid cron or time zone silently disabled a schedule (`docs/REVIEW.md`, section 3 items 4, 6, 7 and 8).

**Decision:** migration 0019 adds `workflow_runs.queue_name` (existing rows take the queue of their oldest task) and `schedules.queue_name`. A run takes the queue of whoever creates it: the API run service, the schedule manager (the schedule's queue), a child (its parent's) or continue-as-new (its predecessor's). Every later enqueue reads the run's own queue: timers, signals, cancels, close, parent wake-ups, stalled recovery. `RunControlOptions` and `RunInteractionsOptions` no longer take a `queueName`. The timer, schedule and janitor loops serve one queue and select only its runs, timers, schedules and stalled runs. `createTaskQueue` and `createJanitor` evaluate "now" in SQL (`now()`) unless a `clock` is injected; the engine injects one only when it was given one, so production time is the database's. `StepHandler` receives `(input, { signal })`. The signal combines the step's own timeout, the lease signal of the task and the worker shutdown. The step task processor races the handler against that signal and reports `lease_lost` for an aborted delivery without recording an attempt, an ack or a nack. A heartbeat that fails with an error for a whole `visibilityTimeoutMs` aborts the task with `LeaseLostError`. A dropped task is aborted, then the worker waits up to `abortGraceMs` (default 1000) for its handler to settle before it nacks. Schedules get `catch_up_policy` (`latest_only` default, or `all`) and `catch_up_window_ms`: `latest_only` starts one run at the latest missed instant, `all` starts every missed instant inside the window, or all of them without a window. A schedule whose cron expression or time zone no longer evaluates moves to the `ERRORED` state with the reason in `error` and `next_fire_at` cleared, and `resume` re-evaluates it.

**Consequence:** a run belongs to one queue for its life; moving a run to another pool is a manual update of `workflow_runs.queue_name`, and its open tasks keep their old queue until they are re-enqueued. Tasks written by other code with a different queue name than the run's are no longer recovered or woken by the run's loops. A step that ignores its signal still stops being waited on, but its code may keep running until it returns, so side effects stay at-least-once. Skipped catch-up instants are not recorded in `schedule_triggers`. Timers and schedules still compare their due time with the injected or system clock, not the database's; only the queue and the janitor read database time. Schedules created before the migration are `latest_only`, which changes what they do after downtime.

## ADR-0047: an exhausted step fails for its workflow, timeouts are durable timers

**Context:** a step that used all its attempts went to the dead letter queue and the run waited on it forever; workflow code had no way to catch the failure and compensate. `step_failed` kept only a name and a message, compensation errors were swallowed, `enforceWorkflowTimeout` was never called and would have appended without closing the run, `sleep(NaN)` surfaced as an unrelated `RangeError`, and `queryRun` on a compacted run claimed the run did not exist (`docs/REVIEW.md`, section 2 items 7, 8 and 11).

**Decision:** the step task processor dead-letters an exhausted step and records `step_failed` with `exhausted: true` in the same transaction as the dead letter and the ack (`addAndAck` runs a callback before the ack, and a lost lease rolls the record back with it). The decision loop and the live session reject `ctx.step()` with `StepFailedError` for such an event, carrying the step id, the step type and the reconstructed error as `cause`; a step that failed with a `NonRetryableError` keeps rejecting with the original error. The dead letter stays for the operator, but the step has its terminal result, so a requeued task is acknowledged as `already_recorded` without running (ADR-0044 allows one result per step). Failure events (`step_failed`, `step_attempt_failed`, `child_failed`, `run_failed`) keep `name`, `message`, `details` (the serializable own properties of the error) and a `cause` chain of at most five links, and the workflow receives them as `error.details` and `error.cause`. A compensation that throws is recorded as `compensation_failed` with its registration index, once, and the other compensations still run. Run timeouts are durable timers: migration 0020 adds `workflow_runs.run_timeout_ms` and `execution_deadline`, and a run created with a limit (API start, `ChildOptions`, continue-as-new inheriting) gets a `run-timeout` and an `execution-timeout` timer row in its creation transaction. The timer loop treats these two ids as engine timers: it locks the run with its parent, appends `run_timed_out` (`kind` `run` or `execution`) and calls `closeRunIfTerminal`, so waiting tasks are withdrawn and the parent receives `child_failed` named `TimedOutError`. `ctx.sleep` rejects a `NaN`, negative or infinite duration with `InvalidSleepDurationError` before it takes a timer id. `queryRun` on a run whose first event was pruned rejects with `RunHistoryCompactedError`.

**Consequence:** the old operator flow "fix the cause, requeue the dead letter, the run goes on" no longer exists: the workflow has already been told, and an uncaught `StepFailedError` fails the run. Recovery is a new run, or a workflow that catches the error and retries with its own logic. `enforceWorkflowTimeout` and `workflowDeadline` remain exported but the engine does not use them. Timeouts are given when a run is created, not by the workflow definition, and a schedule cannot set them yet. A query on a compacted run still cannot be answered, because replay needs the whole history; it now says so. A timeout timer uses the clock of whoever created the run, like other timers, so a fast host can fire it early by its skew.

## ADR-0048: failed authentication is throttled in the API process, and the api holds its own limits

**Context:** an unauthenticated request cost a database query and nothing limited how many a client could send, event streams had no cap or lifetime and each open stream polled Postgres twice every 500 ms, and history and dead letters were returned whole. The quota guard of day 23 protects authenticated namespaces only.

**Decision:** the API handler counts missing or wrong credentials per socket address in a fixed window held in process memory (default 20 per 60 seconds, at most 10,000 tracked addresses) and answers 429 without a query once the budget is spent; successful requests are not counted. Streams are capped per namespace (default 20) and end after a lifetime (default 15 minutes) with a `reconnect` event; the client resumes with `Last-Event-ID`. History and dead letters are paged by cursor (a sequence number and a dead letter id), and the dead letter namespace filter, order and limit run in SQL. `/metrics` renders at most once per `metricsCacheMs` and concurrent scrapes share a render. A repeated idempotency key is answered by a lookup before the insert transaction.

**Consequence:** the throttle is per process and per address, so a fleet multiplies the budget and a proxy shares one budget between its clients; a shared store or a trusted forwarded address would fix both and is listed in `docs/DEFERRED.md`. The history response gained an optional `nextCursor`, so a client that ignores it sees at most 500 events by default: the UI follows the stream instead and the CLI follows the cursor. An address that is throttled cannot use a valid key until its window ends. A duplicate start no longer opens a `workflow.start` span unless it loses a race, which keeps the day 24 behavior and ends the span when it does.

## ADR-0049: production processes are separate, take turns on migrations and publish their own metrics

**Context:** the image ran `wf dev`, which migrates on start, loads the examples, issues a new key on every start and starts compose when the database does not answer. `migrateUp` took no lock, so replicas that start together race on `create table`. `startEngine` never passed `onTaskSettled` or the janitor's counters on, so `dee_task_latency_seconds` and `dee_leases_reclaimed_total` stayed empty, and the sticky router and `stickyFor` were unused, so with N workers the replay cache hit about 1/N of the time (`docs/REVIEW.md`, sections 3 item 11 and 4 items 1 and 2).

**Decision:** `migrateUp` and `migrateDown` hold a session level Postgres advisory lock (`hashtext('dee:migrations')`) from before the migrations table is created until after the last migration, and release it in a `finally`; a connection that cannot release it is destroyed instead of returned to the pool, which drops the lock. `pendingMigrations` reads the state without a lock. `wf serve` runs the API and the ui without an engine, `wf worker` the engine, and both refuse to start on a schema with pending migrations unless given `--migrate`. `wf serve`, `wf worker` and `wf migrate` (and `wf dev`) never start docker compose when `NODE_ENV=production`. `wf migrate down` asks for confirmation through `CliIo.confirm` and refuses when there is no terminal and no `--yes`. `.wf/dev.json` is written with mode 0600. The key of `wf serve` is adopted from `WF_API_KEY` (a new `ApiKeyStore.adopt`, idempotent, refusing revoked or foreign keys), else the namespace keeps its keys, else one is issued and logged once. All flags also read `WF_<NAME>`. `startEngine` creates the `EngineMetrics` of the process (exposed as `engine.metrics` and `engine.recovery`), records every settled task in the histogram and passes the janitor's counters in; `createEngineMetrics` takes `queues` so idle queues have a zero series. A worker can serve `/health`, `/ready` and `/metrics` through `startOpsServer`. `startEngine` also creates a sticky router by default (`stickyRouting`): the task handler claims a run for the deciding worker after every decision that leaves it open and releases the claim when the run closes, the worker polls with `stickyFor` its own id, and `engine.stop` releases the worker's claims. The history compactor runs from a loop when `compaction` is given. The default command of the image is `serve`; compose has `migrate`, `api` and `worker` services.

**Consequence:** a rollout runs `wf migrate up` first (or passes `--migrate` everywhere); forgetting it is a clear start-up error instead of a failing query. The advisory lock is database wide, so two schemas in one database (as the tests use) also take turns. A claim is a row, so a worker that dies holds its runs until the claim expires (`stickyTimeoutMs`, 60 seconds), which is the price of the 100 percent hit rate in `docs/BENCHMARKS.md`; setting `stickyRouting: false` restores the old behavior. Latency and reclaim metrics are per worker process and must be scraped from every worker. `wf dev` also stopped starting compose in production. The `engine` compose service is gone, replaced by `api` and `worker`.

## ADR-0051: packages are built to dist and resolved through a development export condition

**Context:** the `@dee/*` mapping lived in four places (the vitest aliases, the tsconfig `paths`, the cli resolve hook and the chaos resolve hook) and the package `main` fields pointed at a `dist` that was never built, so nothing could be installed outside a checkout.

**Decision:** every package has an `exports` map with a `development` condition that points at `src` and `types` and `default` conditions that point at `dist`; `publishConfig.exports` drops the `development` condition from the packed manifest, because `src` is not shipped. The base tsconfig sets `customConditions: ["development"]` and `rewriteRelativeImportExtensions`, relative imports are written with their `.ts` extension, and the build tsconfigs (`tsc -b tsconfig.build.json`) clear the custom condition so declarations resolve through the `dist` of the referenced projects. Vitest and the processes started from sources use the `development` condition; both resolve hooks and all path mappings are gone. `bin/wf.js` runs `dist` when it exists and otherwise starts itself again with `--conditions=development` on the sources. The browser modules of the ui keep their `.js` specifiers because the browser requests them under that name, and are shipped as sources from `src/client`. The examples take their demo types from `@dee/core` because `@dee/cli` depends on them. `publint` and `@arethetypeswrong/cli` (new dev dependencies, both required by the backlog) check the packed tarballs.

**Consequence:** the tarballs install with `npm install` when their `@dee/*` dependencies are overridden to the tarballs, which `scripts/smoke-install.sh` does; installing from a registry needs the packages published first (day 42). Sources can be run by Node only through the `development` condition, which is a flag, not a hook. The image still runs the sources; moving it to `dist` is day 42.

## ADR-0052: a tag triggers the release, a pre-release tag or a manual run only rehearses it

**Context:** releases were typed by hand: versions edited per package, tags pushed by the owner, the image built but never pushed, and the GitHub release pasted from `CHANGELOG.md`. The day 41 packages install from tarballs only.

**Decision:** the eight published packages are one fixed Changesets version group (`.changeset/config.json`), so one `changeset version` moves all of them together; Changesets writes no changelog (`"changelog": false`) because the repository keeps one root `CHANGELOG.md`, whose section is the release note. `.github/workflows/release.yml` runs on a pushed `v*` tag. A `plan` job decides the mode (`scripts/release-lib.mjs`): a plain tag releases, a tag with a suffix such as `v0.2.0-rc.1` is a dry run, and the manual `workflow_dispatch` trigger is always a dry run and only takes a pre-release tag. Then `verify` runs the full `pnpm run verify`; `npm` builds, packs, checks with publint and attw and publishes the tarballs in dependency order with `npm publish --provenance`, authenticated by the workflow identity (trusted publishing, no stored token; it needs npm 11.5 or newer, so the job installs `npm@11`); `image` builds for amd64 and arm64 with an SBOM and max provenance and pushes semver tags to GHCR; `github-release` cuts the changelog section out and creates the release. A dry run executes every step; only `npm publish` gets `--dry-run`, the GHCR login is skipped and the push is off, and the release is created as a draft pre-release. A pre-release tag may carry the base version of the packages (`v0.2.0-rc.1` with `0.2.0`), a plain tag must equal it. The image build installs everything, runs `pnpm run build`, reinstalls with `--prod` and so runs from `dist`.

**Consequence:** a release is `changeset version`, a changelog section, a commit, a tag. The pipeline cannot be proven end to end before the owner's accounts exist: the npm trusted publisher and the GHCR package settings are one-time owner steps in `docs/RELEASING.md`, so the first real run is the first proof of the two publishing steps. A dry run leaves a draft release behind that the owner deletes. The npm job publishes eight packages one after another; a failure half way leaves some versions published, and the fix is a new patch version, because npm does not allow republishing.

## ADR-0053: a transactional start writes on the caller's transaction inside a savepoint

**Context:** a run could only be started through the API or a pool owned by the engine, each with its own transaction, so an application that writes a row and starts a workflow had a gap between the two commits (`docs/REVIEW.md`, section 6 item 4). The engine tables also had to sit in whatever schema the connection's `search_path` named, which in an application database is `public`, next to tables that may share their names.

**Decision:** `startWorkflow`, `signalWorkflow` and `cancelWorkflow` in `@dee/core` take a `PoolClient` with an open transaction. Each opens a savepoint, so a client outside a transaction is refused (`NoOpenTransactionError`, from Postgres error 25P01) and a rejected call rolls back to the savepoint and leaves the caller's transaction usable. With `schema`, the call sets `search_path` to that schema with `set_config(..., true)` for its own statements and sets the previous value back before releasing the savepoint; the existing helpers (`appendEventsOnClient`, `applyRunTimeoutsOnClient`, the signal and cancellation helpers, now shared with `createRunInteractions` and `createRunControl`) keep their unqualified table names. A namespace is resolved by name and created when missing, with a read before the upsert so concurrent starts in one namespace do not all lock its row. The SQL function `start_workflow` (migration 0021) is plpgsql with `set search_path from current`, so it resolves the engine tables of the schema it was migrated into from any caller, and it honours idempotency keys the same way. `migrateUp`, `migrateDown` and `pendingMigrations` take `{ schema }`: `migrateUp` creates the schema, each sets the connection's `search_path` to it for the run and puts the old value back before the connection returns to the pool. The engine itself uses a pool created with `createPool(env, { schema })`, which existed already. The integration suite already runs every test file in its own `test_<uuid>` schema through `search_path`; a test now asserts that, and the outbox example runs the engine in a schema next to an application schema.

**Consequence:** the public functions take a `pg` `PoolClient`, so a bare `pg.Client` or another driver's connection needs an adapter (`docs/DEFERRED.md`). A long application transaction that signals or cancels holds the run row lock until it ends. The SQL function writes plain JSON and sets no timeouts. The run timeout of a transactional start counts from the start of the caller's transaction, since `started_at` defaults to `now()`. The CLI has no `--schema` flag yet, so `wf worker` and `wf serve` still use the `search_path` of `DATABASE_URL` (a `?options=-c search_path=dee` parameter works).

## ADR-0054: history events carry a format version, and exported histories gate workflow and schema changes

**Context:** nothing said what the project would not break, the stored events had no version, so a newer engine's events could not be told apart from corrupt ones, and the only way to check that a workflow change was safe was to deploy it and watch for `NonDeterminismError`. The replay harness of day 6 replayed hand-written histories of one fixture workflow only, and nothing caught an accidental change of a package's exports.

**Decision:** migration 0022 adds `run_events.event_version` (`smallint`, default 1, at least 1); `appendEventsOnClient` writes `CURRENT_EVENT_VERSION` (1) and every read goes through `readVersionedEvent`, which validates an event of this version or older with the schema and reads an event of a newer version forward-compatibly: unknown fields are dropped (as zod already did), an unknown type is refused with `UnsupportedEventError` instead of a schema error. A new optional field does not raise the version, a new event type does. `StoredEvent` and the API history entries carry `version`. A history export is a JSON envelope (`format: "dee.history"`, `formatVersion` 1, `runId`, `workflowType`, `exportedAt`, events with sequence number, time, version and payload); it must start with `run_started` at 1, so a compacted run cannot be exported. `wf history export` reads it through the API. `replayHistories` replays exports through `runDecisionLoop` with the run id as the random seed and the last event's time as the clock, reports per history instead of throwing, and fails on non-determinism, a version mismatch, forbidden APIs, and a closed history whose run the code would close differently or not at all; an open history may end with new commands. `NonDeterminismError` gained `recordedId`, the id of the recorded command where replay diverged, so a failure names its event. `wf replay` prints one line per file and exits 1 on any failure. The gate in `test/history-gate.test.ts` replays histories recorded from real engine runs (`test/fixtures/history-gate`, written by `pnpm run history-gate:record`) that together hold every event type, and reads the older raw fixtures with the current schema; it takes an `EventReader`, so tests prove it fails for a removed type, a renamed field, a changed field type and a new required field, and passes a new optional field. `@microsoft/api-extractor` (new dev dependency, named by the backlog) writes one report per published package to `api-reports/`; `pnpm run api:check` runs in the `packages` CI job after the build and fails on any change of the exports until `pnpm run api:update` is committed. `docs/STABILITY.md` holds the policy.

**Consequence:** a release that adds an event type must upgrade every worker before the type is written, and a version bump also moves the column default that `start_workflow` relies on. A workflow change is only as well checked as the histories someone exported; the engine cannot know which paths matter. Replaying a closed history does not compare the result value, only how the run closed, so a changed result is accepted as compatible. The reports list the types the entry points use without exporting them (`ae-forgotten-export`); they are recorded, not fixed. Recording the gate fixtures again rewrites their run ids and times, so the diff of a re-recording is large and is reviewed by its event types. Writing the recorder found a real engine bug: a step that used all its attempts recorded `step_failed` but enqueued no workflow task, so the run waited for stalled run recovery (60 seconds by default) before it failed or caught the error; the step task handler now enqueues one, with a test that was red first.

## ADR-0055: an update is validated under the run lock and applied at its position in the history

**Context:** a caller could change a running workflow only with a signal, which returns before the workflow has reacted, carries no result and cannot be refused, so a request such as "add this item unless it is in the cart already" needed a signal, a query and a race between them. Queries existed in core but were not reachable over HTTP, and the API built its interactions over an empty workflow registry.

**Decision:** `defineUpdate(name, { validate?, handler })` declares an update and `ctx.setUpdateHandler(definition)` registers it; the latest registration of a name wins. Two event types are added: `update_accepted` (`updateId`, `updateName`, `argument`) and `update_completed` (`updateId`, `result`, optional `error`), and one command, `complete_update`. `acceptUpdateOnClient` locks the run row with `for update`, reads the history on the same connection, replays it with the run id as the random seed (as a worker decides), and runs the validator against the replayed state under the forbidden API guard; a validator that throws raises `UpdateRejectedError` before anything is written. An accepted update appends `update_accepted` and a `WORKFLOW_TASK` in the same transaction. Because the lock is held from the read to the commit, concurrent updates are validated one at a time against the state the earlier ones left. In the decision loop every `update_accepted` event is a delivery at its history index, released by the same ordered feed that releases step, timer and signal results; the delivery calls the registered handler with the argument, and when its promise settles and no `update_completed` for the id is recorded yet, the decision emits `complete_update` with the result or the recorded error. The handler runs against the workflow context, so it may schedule steps. A replay therefore applies the same updates in the same order at the same points, queries see their effect, and the validator is never run again during replay: acceptance is final. An `updateId` that the run already accepted records nothing and waits for the first outcome. `awaitUpdateOutcome` polls the history from the accepted sequence number every 50 ms with `node:perf_hooks` and `node:timers` (which decisions do not patch) until `update_completed` appears, the wait (default 10 s, at most 60 s) ends or the run closes; the caller gets `completed`, `failed` or `accepted`. The live session of the sticky decider does not resume update handlers or update events and falls back to a full replay. The API maps the outcome to 200 or 202, a rejected or unknown update and an unknown query to 400, a compacted history to 409 and a missing workflow registry to 501 (`WorkflowNotLoadedError`); `createRunService` now builds its interactions over the `workflows` it is given, and `wf dev` passes the registry of its modules to the API.

**Consequence:** the API process must hold the workflow code to accept an update or answer a query, so `wf serve` without `--module` answers 501, and `wf dev` now refuses to start a run of a type its modules do not define. Accepting an update costs a full replay while the run row is locked, so a long history makes concurrent updates of one run slow, and a signal or a decision commit that needs the same lock waits behind it. A workflow that registers an update handler is never served by the live session, so it pays a full replay per decision. An update whose handler is still waiting when the run closes never completes; its caller gets `accepted`. The wait is a poll, not a notification.

## ADR-0056: events are addressed by name and correlation key, buffered per namespace, and paired with waits under an advisory lock

**Context:** a workflow could wait only for a signal sent to its own run id, so the sender had to know which run to address, and a message that arrived before the run existed or before it waited had nowhere to go. Signals had no identity, so a sender that retried a timed-out request recorded the signal twice. Starting a run on first contact needed a start and a signal and a race between them, and a run that continued as new dropped the signals it had not consumed yet, while a signal sent to the closed run was refused.

**Decision:** migration 0023 adds four tables. `external_events` keeps every event sent with `POST /v1/events` (namespace, name, correlation key, payload, `received_at`, `expires_at` from a buffer period of one hour by default, at most seven days). `ctx.waitForEvent(name, { match, timeoutMs })` issues a `wait_for_event` command recorded as `event_wait_started` (with `expiresAt` when it has a timeout, plus an ordinary timer for the timeout); the recorder stores it in `event_waits` in the decision's transaction and delivers the oldest buffered event of that name and key that the run has not received yet. `sendEvent` delivers to every open, unexpired wait of the name and key, then starts a run for every matching row of `event_triggers` (idempotency key `event:<eventId>:<triggerId>`, input `{ eventId, eventName, key, payload }`). A delivery locks the run row, marks the wait, appends `event_received` and enqueues a workflow task; a unique index keeps one event per run. Sending and registering both take `pg_advisory_xact_lock` on the hash of namespace, name and key before any run lock, so an event and a wait that race are always paired and the two paths take locks in the same order. Replay resolves a wait from `event_received` or rejects it with `EventWaitTimeoutError` from `timer_fired`, whichever comes first in the history; the wait is a new command kind in the matcher, so a changed name or key is a `NonDeterminismError`. `ctx.condition(predicate, timeoutMs)` is checked after the initial drain and after every history delivery, repeating until no condition changes, so it resolves at the same history position on every replay. A signal may carry `signalId`; `signal_ids` holds `(first_run_id, signal_id)`, so an id is recorded once per continue-as-new chain, and the event records it. `signalRunOnClient` follows a `CONTINUED_AS_NEW` run to its successor under each run's lock. The `continue_as_new` command lists the unconsumed signals (the ones past the number of `waitForSignal` calls per name), and `createContinuedRunOnClient` records them after `run_started`; since the decision is appended with optimistic concurrency, a signal that lands between the read and the commit makes the decision retry and is counted. `signalWithStart` inserts the run with the workflow key as its idempotency key (`on conflict do nothing`, which waits for a concurrent insert to commit) and signals whichever run holds the key.

**Consequence:** an event is delivered to every run waiting for it and to every later waiting run within its buffer period, so it is a broadcast with replay, not a queue: a workflow that wants exactly one consumer has to use a key only one run waits for. Buffered events are never deleted yet; they only stop matching after `expires_at`. A trigger has no way to be removed over the API, and `event_waits` rows stay after the run closes. The live session of the sticky decider does not serve `waitForEvent` or `condition` and falls back to a full replay. A condition cannot be a branch of `ctx.select`, because it has no history position of its own. A signal-with-start whose key belongs to a closed chain answers `RunNotOpenError` instead of starting a new run, because the key is the run's idempotency key and stays taken.

## ADR-0057: search attributes live in an indexed jsonb column and visibility queries compile to bound parameters

**Context:** operators could list runs only by status, workflow type and start time, so finding "the failed runs of customer c-1" meant reading inputs one run at a time. The backlog asks for typed attributes set at start and updated from the workflow, a memo, indexed storage, and a filter grammar that is parsed into parameterized SQL, answers over 100,000 runs in under 100 ms and refuses a malformed or hostile query with the position of the problem.

**Decision:** migration 0024 adds `workflow_runs.search_attributes` (`jsonb`, an object, default `{}`) with a GIN index (`jsonb_path_ops`), `workflow_runs.memo` (`jsonb`, nullable) and a btree index on `(namespace_id, status, started_at desc, id desc)`. Attributes are typed by their JSON value: strings (at most 256 characters), finite numbers and booleans, at most 32 per run, under identifier names that cannot shadow a run field or a keyword; there is no per-namespace schema to register. `run_started` gains optional `searchAttributes` and `memo`, so the history alone tells a replay what a run started with. `ctx.upsertSearchAttributes(upsert)` (values replace, `null` removes) validates and merges synchronously and emits an `upsert_search_attributes` command, recorded as the new event type `search_attributes_upserted`; like `ctx.now()`, the nth call of a replay matches the nth recorded event, and a different upsert is a `NonDeterminismError`. The recorder applies the event to the run row in the decision's transaction (`(search_attributes || set) - removed`), before a `run_continued_as_new` in the same decision, and a decision that continues as new keeps its upserts ahead of the `continue_as_new` command. `createContinuedRunOnClient` copies the predecessor's attributes and memo onto the new row and into its `run_started`. `compileVisibilityQuery` tokenizes and parses the grammar of `docs/API.md` by recursive descent and compiles it to a SQL condition in which every literal and every attribute name is a `$n` parameter; only fixed column names, operators and casts are written by the compiler. Attribute equality compiles to `search_attributes @> $n::jsonb` (the GIN index), an ordering to a `case` on `jsonb_typeof` so a value of another type never reaches a cast, `not` to `not coalesce(x, false)`. Limits (2000 characters, 32 comparisons, 16 levels) bound the work a query can ask for. `VisibilityQueryError` carries a 1-based position and the API answers 400 `invalid_query` with it in `details`.

**Consequence:** a query cannot take the shape of SQL, whatever it holds, and the plans of `docs/BENCHMARKS.md` show the example query answering in about 5 ms over 100,000 runs. An ordering on an attribute is not indexed, so a selective range with nothing else to narrow it walks the namespace's runs newest first; a time stored as a string compares as text, which is correct for UTC ISO-8601 values only. The live session of the sticky decider does not serve `upsertSearchAttributes` and replays in full. A memo cannot be changed after start, the SQL function `start_workflow` takes neither attributes nor memo, `wf run start` has no flags for them, and a run started before migration 0024 has no attributes.

## ADR-0058: heartbeats are stored per step, the schedule-to-close deadline rides on the task, and definitions name what strings named

**Context:** a step had one timeout, per attempt, so a long step could not say it was still alive, a stuck step was only noticed when its whole timeout passed, a retried attempt had to start from the beginning, and nothing bounded the total time of a step across its retries. Workflow code named steps, children, signals and queries by string, so the compiler checked neither the input nor the result.

**Decision:** migration 0025 adds `step_heartbeats` (`run_id`, `step_id`, `attempt`, `details` as `jsonb`, `recorded_at`), one row per step, removed with its run. `StepContext` gains `attempt`, `heartbeatDetails` and `heartbeat(details)`; `detachedStepContext` builds one for code outside a worker. The step task processor reads the last heartbeat before an attempt and passes its details on; `heartbeat` restarts the heartbeat deadline at once and stores the details asynchronously, coalesced to one write in flight with only the latest details queued, and an upsert keeps the row of the newest attempt, so a late write of an aborted attempt cannot overwrite the next one. Pending writes are flushed before the attempt's outcome is recorded, so the retry reads the last details. Heartbeats are not events: they would grow the history with progress that replay never needs. `runWithDeadlines` runs an attempt against fixed deadlines (start to close, the remaining schedule to close) and a heartbeat deadline, all on the processor's injectable timers, and aborts the step's signal with the error of the deadline that passed. The schedule-to-close deadline counts from `scheduledAt`, which `enqueueStepTaskOnClient` writes into the task payload with the decision's clock; a requeued dead letter gets a fresh one. When the deadline passes during an attempt, before a delivery runs, or before the next retry would start, the step is recorded as `step_failed` with a `StepScheduleToCloseTimeoutError`, without a dead letter: it is a timeout, not an exhausted retry budget. `reconstructError` rebuilds that error with its class from its name and `details.timeoutMs`, in the decision loop and the live session alike. `defineStep` takes `startToCloseTimeoutMs` as another name for `timeoutMs`, `scheduleToCloseTimeoutMs` and `heartbeatTimeoutMs`. `WorkflowContext` gains overloads that take a `StepDefinition`, a `WorkflowDefinition`, a `SignalDefinition` (`defineSignal`) or a `QueryDefinition` (`defineQuery`) in place of the name; the input parameter is `NoInfer` of the definition's input, so the definition decides the type and a wrong input is a compile error. The implementations read the name from the definition and record exactly what the string form records.

**Consequence:** a typed and an untyped workflow write the same history and replay each other's runs, so a team can type a workflow without a version gate. A definition passed to `ctx.step` must still be registered with the worker by its name; the context does not carry the handler to the worker. A heartbeat costs a database write, coalesced but not throttled by time, so a step that heartbeats in a tight loop writes as fast as the database answers. A heartbeat does not extend the task's lease; a step that outlives its lease is still redelivered. A task enqueued before this change has no `scheduledAt` and so no schedule-to-close deadline. A heartbeat timeout only fires in a live worker: a worker that dies is noticed by lease expiry as before. The client side (`signalRun`, `queryRun`, `updateRun` and the HTTP API) still takes names, so the payload a caller sends is not checked against a definition.

## ADR-0059: priority belongs to the run, tasks copy it by trigger, and namespaces take turns by lease sequence

**Context:** the queue handed out tasks oldest first within a queue name. An urgent run waited behind every task queued before it, a namespace with a large backlog took every free slot until it was drained, and one pool per engine meant that steps which run for minutes held the slots the decisions of every other run needed.

**Decision:** migration 0026 adds `priority` (integer, -1000 to 1000, default 0) to `workflow_runs` and `tasks`, and a `before insert` trigger on `tasks` that sets a task's priority from its run, so the fifteen places that write tasks need no change and a task can never disagree with its run. A run gets its priority at start (`POST /v1/runs`, the embedded `startWorkflow`, `insertRunOnClient`); a child run selects its parent's in the insert, and a continued run copies its predecessor's. The dequeue reads one lane per namespace and task type (`namespaces` crossed with the requested types) and takes up to `limit` rows from each lane through `tasks_fair_dequeue_idx` (`queue_name, namespace_id, task_type, priority desc, visible_at, created_at, id`, partial on open states) with `for update skip locked` inside the lateral subquery, so each lane is an index range read with no sort however long the backlog. The candidates are ranked by priority, then by their position within their namespace and priority, then by the lane's turn, then by age, and the first `limit` are leased. The turn is the highest `lease_seq` of the lane: every lease stamps the next value of `task_lease_seq`, and `tasks_lane_turn_idx` makes the maximum one index probe, so the namespace served least recently goes first without a shared counter row that every dequeue would update and serialize on. The rows are returned in that order. `DequeueOptions.taskTypes` and `WorkerOptions.taskTypes` restrict a dequeue to some task types, and `startEngine` runs two workers on its queue, one for `WORKFLOW_TASK` (`workflowConcurrency`) and one for `STEP_TASK` (`stepConcurrency`), each defaulting to `concurrency`.

**Consequence:** a high-priority task is taken by the next poll after a slot frees, and a namespace with ten tasks finishes them within the first twenty leases while another namespace holds ten thousand. Priority is strict: a steady stream of high-priority work starves lower priorities, by design. A dequeue locks up to `limit` rows per lane and releases the unused ones at the end of the statement, and it probes every namespace, so the cost of an empty poll grows with the number of namespaces. Fairness is between namespaces of one queue, not between queues or workflow types. An engine with the default settings now runs up to twice as many tasks at once as before (four decisions and four steps), so its database pool needs room for both. The priority of a running run cannot be changed, a child cannot ask for a priority of its own, the cli and the `start_workflow` SQL function take none, and tasks written before migration 0026 have priority 0.

## ADR-0060: concurrency keys are evaluated by the worker and enforced by slot rows at dequeue

**Context:** a workflow or a step needs to limit how many of its runs or executions run at once per business key, such as one checkout per customer. The key is a function of the input, so only code that has the definition can compute it, and most paths that start a run (the HTTP API without `--module`, the embedded `startWorkflow`, event triggers, schedules) have no definition. The limit must hold however many workers dequeue at once, a sleeping or waiting run must not hold a slot, and a dead worker's slot must come back.

**Decision:** `defineWorkflow` takes a third argument with `concurrency: { key, limit }`, and `defineStep` takes the same option. Migration 0027 adds `concurrency_key` and `concurrency_limit` to `workflow_runs` and `tasks`, `step_concurrency_key` and `step_concurrency_limit` to `tasks`, the tables `concurrency_slots` and `concurrency_slot_history`, and triggers. The worker evaluates a key the first time it leases a task that has none while its definition has a rule: `requeueWithConcurrency` writes the key on the run and its open tasks (or on the step task) and returns the task to `PENDING` in one transaction, and the handler throws `TaskReleasedError`, which the worker neither settles nor reports. The task insert trigger that copied the priority now also copies the run's key. The dequeue statement skips a keyed task whose pool is full (unless its run already holds a run slot), and in the same statement inserts one `concurrency_slots` row per run or step it leases into a free slot number below the limit, leasing only the tasks whose rows went in. The primary key (namespace, scope, key, slot) is the arbiter: a concurrent insert of the same slot waits for the other transaction and then does nothing, and a step slot whose lease expired is overwritten by `on conflict do update ... where expires_at <= now`. A run slot is freed by an `after update` trigger on `tasks` when the run's last open task (pending or leased) closes; the trigger takes a per-run advisory lock first so two last tasks closing at once cannot both see the other open. A step slot is freed when its task's lease token changes and follows the lease's `visible_at` when it is extended. Every insert, overwrite and delete of a slot writes `concurrency_slot_history` with numbers from one sequence, and the new `concurrency-limit-held` invariant checks that no point of that history has more holders of a key than the limit, and that every leased keyed task holds its slot. The step task processor gained `beforeSettle`, where the engine now enqueues the run's next workflow task before it acks the step task, so a run with a step behind it is never without an open task.

**Consequence:** with limit 1, 50 runs over 5 keys never had two runs of a key active at once, in process and in the slot history; a sleeping run frees its slot; a dead worker's step slot comes back when its lease expires. Every key works for every start path, at the cost of one extra lease and requeue per keyed run (and per keyed step task) to record the key. The dequeue scans past blocked keyed tasks on every poll and may lease fewer than `limit` when a batch holds several tasks of a full key. A run keeps its slot while a step waits out a retry backoff. The slot history grows with every acquisition and is not pruned. These are listed in `docs/DEFERRED.md`.

---

## ADR-0061: rate limits are sliding windows in Postgres, and debounced and queued starts wait in a pending table

**Context:** day 51 asks for rate limits per queue or per key that hold across every process, replacing the in-process token bucket of ADR-0033 for namespace quotas too, and for three start options: `debounce` (the last start in a window wins), `singleton` (refuse or queue while one is open) and an idempotency key with a TTL. Three api processes must together admit no more than the limit, 10 starts in a debounce window must give one run with the last input, 20 concurrent singleton starts must open exactly one run, and an expired idempotency key must start a new run.

**Decision:** migration 0028 adds `rate_limit_admissions` and the function `take_rate_limit(bucket, limit, period_ms, now)`. It takes a transaction scoped advisory lock on the bucket, deletes the admissions older than the period, and inserts one when fewer than the limit remain, answering the wait until the oldest admission that must leave does. That is a sliding log rather than a token bucket: a token bucket of capacity `limit` and refill `limit / period` can admit up to twice the limit within one period, a sliding log never more than the limit. `now` is passed by the caller, so tests drive the window with a fake clock. `createSharedRateLimiter` wraps the function; `createQuotaGuard` uses it by default with the bucket `namespace:<id>` and maps a quota to `burst` admissions per `burst / ratePerSecond` seconds (`quotaRateLimitRule`); `createRateLimiter` stays exported but nothing in the engine uses it. `defineStep` takes `rateLimit: { limitPerPeriod, periodMs, key? }` and `startEngine` takes `queueRateLimit`; the engine's task handler checks the step's bucket and then the queue's after it leases a step task and before running it, and hands a refused task back with `deferLeasedTask`, visible again when the window has room, without counting an attempt (the same release path as the concurrency keys of ADR-0060).

The same migration adds `idempotency_expires_at` and `singleton_key` to `workflow_runs` and the table `pending_starts`. `admitStartOnClient` runs inside the start's transaction: with a key, it first clears the key of a run whose TTL ended, so the insert can take it, and the lookup of an earlier run ignores expired keys. A debounced start takes an advisory lock on its key, then merges into the open window (replacing the input and counting the start) or opens a new one, firing a window that is already due first. A singleton start takes an advisory lock on its key and starts the run with `singleton_key` set only when no run of the key is `RUNNING` and no start is queued for it; otherwise it throws `SingletonRunOpenError` or queues a pending start. A pending start's id is the id its run will get. `createPendingStartFirer` fires due windows with `for update skip locked` and, per singleton key with no open run, the oldest queued start under the key's lock; the worker's schedule loop runs it each pass. The run service gained `requestStart`, which may resolve a pending start; `startRun` keeps its signature and refuses the two pending options. `POST /v1/runs` answers 202 for a pending start, 409 `singleton_open` for a refused singleton and 400 `invalid_start_policy` for unsupported combinations.

**Consequence:** each rate limited call is one statement and one lock on its bucket, so a hot bucket serializes its callers; admissions are bounded by the limit per bucket and need no sweep. A refused step task costs one lease. The singleton guarantee holds for runs started through `requestStart` and the firer, which both take the key's lock; other start paths do not set or check the key. Debounce, singleton and the TTL are only in the HTTP API and the run service so far, and pending starts fire only while an engine runs. The edges are listed in `docs/DEFERRED.md`.

---

## ADR-0062: pauses are rows the dequeue skips, and cancel-other buffers the trigger until the cancelled run closes

**Context:** day 52 asks operators to pause and resume a run, a queue and a namespace so that paused work stays queued and timers still fire into a held state, for the overlap policies `skip`, `buffer_one`, `cancel_other` and `allow_all`, for a backfill of a time range that starts each run exactly once even when it runs twice, for schedule pause, and for an API, CLI and UI over all of it. The schedule manager of day 14 already had `skip`, `buffer_one`, `allow_all`, pause and a repeatable backfill, but no API, CLI or UI.

**Decision:** migration 0029 adds `pauses` with a scope (`namespace`, `queue` or `run`), the namespace, the queue name or the run id, a reason and a time, and one partial unique index per scope. `createPauseControl` inserts and deletes these rows and reads the pauses of a run. Each dequeue first reads the pauses that concern its queue (one small statement), and only when there are any does the dequeue statement get two extra parameters: the namespaces whose lanes it drops (a paused namespace, or the dequeued queue paused in that namespace) and the runs whose tasks it passes over. The filters are left out of the statement when nothing is paused because the statement's estimated cost on a fresh database already sits just under Postgres' default `jit_above_cost` of 100,000; written as `not exists` subqueries they pushed it over, JIT compilation added about 100 ms to every poll, and the chaos suite's `db-connection-loss` scenario stopped converging. A test now checks the statement's estimated cost against `jit_above_cost` with and without pauses. Nothing else reads the table: the timer scheduler, signals, events and the recorder keep writing events and enqueueing tasks, which wait as `PENDING`, and a lease already taken is left alone. A queue is paused per namespace because the API serves every namespace and must not let one tenant hold back another's queue. Pausing what is paused keeps the first pause. The same migration widens the schedule overlap check to `cancel_other`: the trigger requests cancellation of the schedule's open runs with `cancelRunOnClient` inside its own transaction and then takes the `buffer_one` path, so the new run starts only once the old ones closed and two runs never overlap. `backfill` takes an `overlapPolicy` override, and the manager gained `list` and `listTriggers`. The API exposes `POST /v1/pauses`, `POST /v1/pauses/resume`, `GET /v1/pauses`, a `paused` field on the run description, and schedule create, list, describe, triggers, pause, resume and backfill routes; a backfill request is capped at 1000 triggers. `wf pause`, `wf resume` and `wf schedule` call those routes, and the UI has a pause button and hint on the run page and a schedules and pauses page.

**Consequence:** a paused queue dequeues nothing and gives back every task in order after the resume; every poll pays one extra read of `pauses`, and a pause created between that read and the dequeue statement lets that one poll lease a held task. A paused run's expired lease is reclaimed only after the resume. A pause does not interrupt a task that is running, does not free a concurrency slot and leaves no trace in the history. `cancel_other` depends on the workflow honouring its cancellation; one that ignores it keeps the buffered trigger waiting. The remaining edges are in `docs/DEFERRED.md`.

---

## ADR-0063: the hot paths are SQL functions, a run has one pending workflow task, and heartbeats write a column no index covers

**Context:** day 28 found that a saturated engine is limited by the number of statements per run, not by the work Postgres does for each, and counted about 47 statements for a run that starts and completes three steps in the benchmark harness (55 by day 52, after the pause read of the dequeue and the run close of the later days). Day 53 asks for at most 15, for a partial unique index on pending workflow tasks so a fan-out does not cause one replay per result, for batched acks and heartbeats, for a heartbeat that can be a HOT update and for per-table autovacuum settings on `tasks`, `timers` and `run_stickiness`, without the chaos suite breaking an invariant.

**Decision:** migration 0030 adds five plpgsql functions, each called as one statement: `append_run_events` (the sequence check and the insert of `EventStore.append` and `appendEventsOnClient`, raising SQLSTATE `DEE01` with the current sequence in its detail, which `toConcurrencyError` turns into a `ConcurrencyError`), `insert_run` (the run row, its `run_started` event and its first workflow task, used by `insertRunOnClient` and by the run service, which needs no transaction at all for a start without an idempotency key, a start policy or a timeout), `record_step_result` (the run lock, the terminal check, the existing result check, the result row and its event; with a task and a follow-up queue it also enqueues the run's next workflow task and acks the step task, which is `ResultRecorder.completeStepTask` and the step processor's new `followUp` option that the engine uses), `record_workflow_task` (the parent and run locks, the task key and terminal checks, the sequence check, the events and the task result row, returning the stored projection and the unfolded events when the decision closes the run) and `close_run` (the projection write, the withdrawal of pending tasks and the check for a parent link and open children). A decision with no side effect is one statement without a transaction; one that closes the run is `begin`, `record_workflow_task`, `close_run`, `commit`, with the projection folded in TypeScript between the two calls. Decisions with children, timers, event waits, search attributes or continue-as-new keep their side effects in TypeScript inside the transaction. `refreshProjection` returns after one read when the row is already up to date.

Migration 0031 completes all but the earliest duplicate pending workflow task of every run, adds the unique index `tasks_one_pending_workflow_task_idx (run_id) where task_type = 'WORKFLOW_TASK' and state = 'PENDING'` and a `before insert` and `before update of state` trigger on `tasks`. The trigger locks the run row (`for no key update`) and looks for the run's pending workflow task. One that was never delivered (`attempts = 0`) absorbs the new one: it becomes visible at the earlier of the two times, keeps the higher priority and the concurrency key, and the insert is dropped (or, for an update back to `PENDING` such as a nack or a reclaim, the updated task is completed instead). One that was already delivered may have recorded its decision under its task key, so a redelivery of it decides nothing; it is completed and the newer task is kept, because a decision taken later always sees every earlier cause. The first version merged into any pending task, and the chaos suite found runs left `RUNNING` with no open task: a reclaimed workflow task that had already recorded its decision absorbed a step's follow-up, and its redelivery was a duplicate. A test now covers that sequence. Every insert path is covered without changing it; `TaskQueue.enqueue` and the timer scheduler read the pending task's id when their insert was merged. A first version took a transaction scoped advisory lock per run; a seed of 10,000 workflow tasks in one statement then ran out of shared lock memory under the full test suite, while a row lock is kept in the tuple and costs no lock table entry.

Migration 0032 adds `tasks.lease_extended_until`, which no index covers. A heartbeat (`extend`, `extendMany`) writes only that column and `updated_at`, so Postgres can apply it as a HOT update. A lease now ends at the later of `visible_at` and `lease_extended_until`: the dequeue, the janitor's reclaim, the invariant checker and the step slot trigger read both, and a new lease clears the column. The same migration sets `fillfactor` and autovacuum thresholds on `tasks` (70, vacuum at 1% plus 500 dead rows, analyze at 2%), `timers` and `run_stickiness` (80 and 70, vacuum at 2% plus 200, analyze at 5%), all with a cost delay of 1 ms. `TaskQueue` gained the optional `ackMany` and `extendMany`, one statement for a list of leases, and the worker sends the acks and the heartbeats of one event loop turn through them (`createLeaseBatcher`).

**Consequence:** the benchmark's three-step run costs 14 statements instead of 55 (test `statements.integration.test.ts`), and the engine's own three-step run 86 instead of 150 counted the same way, including one loop tick and the shutdown. A burst of step results for one run gives one pending decision. The functions move logic into SQL, so a change to the recorder now has two places to keep in step, and the TypeScript code paths for runs with side effects remain. Merged workflow tasks keep the payload of the first, so the `reason` of a pending task no longer lists every cause. The row lock taken for every workflow task insert serializes inserts per run and can deadlock with a transaction that locks two runs in the other order, which Postgres detects and aborts. The dequeue reads one more column. The engine path still costs far more statements than the benchmark path: the step processor's reads before a step and the engine's markers after a decision are listed in `docs/DEFERRED.md`.

---

## ADR-0064: background loops run on the holder of a session advisory lock, wake-ups are opt-in notifications, and timers fire in batches

**Context:** day 54 asks for low latency on an idle queue and for no duplicated background work: a `LISTEN`/`NOTIFY` wake-up on enqueue behind a flag, one notification per transaction, on a dedicated connection, with polling as the fallback; the timer, schedule and janitor loops on one elected process per queue through an advisory lock, with fast takeover; timers fired in batches; and the sessions this needs documented for PgBouncer. Until now every engine ran every loop, which was safe (each loop claims its rows with `skip locked` or a transaction lock) but repeated the work in every process, and an idle worker found new work only after its poll backoff of up to 500 ms per hop.

**Decision:** `startLeaderElection` holds a candidacy on a dedicated session (`createSessionConnector`, a `pg.Client` opened with the pool's settings outside the pool, or at `sessionConnectionString`). It calls `pg_try_advisory_lock(hashtext(current_schema()), hashtext('dee.leader:' || key))` once at start and then once per lease period while it follows, and `select 1` once per period while it leads. A session lock was chosen over a lease row with an expiry because Postgres releases it the moment the session ends, which gives a fast takeover after a crash without a clock comparison, and costs no write while the leader is healthy. The schema is part of the key, like the janitor's lock, because tests and tenants share a database. `startEngine` starts the timer, schedule, janitor and compactor loops when elected and stops them when deposed; `leaderElection: false` restores the old behaviour, and `engine.isLeader` tells which engine leads. The candidacy steps down at once when its session reports an error or ends, and stops its loops before it tries again.

Migration 0033 adds a statement-level `after insert` trigger on `tasks` with a transition table that sends `pg_notify('dee_wakeup', '{"schema":..., "queue":...}')` once per distinct queue of the statement; Postgres folds identical notifications of one transaction into one. Its `when` clause is `current_setting('dee.notify_wakeups', true) = 'on'`, so it fires only for sessions that ask for it: `createPool({ notifyWakeups: true })` sets it for a pool, `alter database ... set` for every session. The flag is on the producer rather than the listener because a notifying commit takes a database-wide lock on the notification queue, which a busy database without listeners should not pay. With `wakeups: true`, `startEngine` runs `startWakeupListener` on a second dedicated session: it `LISTEN`s, keeps the notifications of its schema and queue, calls `Worker.wake` on both pools, and after a lost session reconnects and wakes once, because notifications sent meanwhile are lost. `Worker.wake` polls at once and resets the backoff, and a wake that arrives during a poll ends the next wait at once. A decision that recorded events also wakes the engine's step pool in process.

The timer scheduler's `tick` fires a batch in one transaction: it selects up to `batchSize` due timers (`for update of timers skip locked`), locks their runs in id order and reads their current sequence numbers in one statement, inserts all `timer_fired` events with consecutive sequence numbers in one statement, updates all timers in one, inserts one workflow task per run in one (the pending task merge of ADR-0063 still applies) and reads the pending task ids in one. Timers of runs that are no longer `RUNNING` are cancelled in the same update. A run timeout timer keeps its own transaction (`timeOutRunOnClient`), and a batch ends before it, so the order by `fire_at` holds.

**Consequence:** idle start-to-first-step latency drops from a p50 of 520 to 720 ms to about 14 ms (`docs/BENCHMARKS.md`). With three engines, only one runs the loops, and a killed leader is replaced within two lease periods (`leader-election.integration.test.ts`, `leader-loops.integration.test.ts`). 10,000 due timers fire exactly once across three schedulers. Each engine now holds one connection outside its pool, two with wake-ups, which a transaction-mode pooler cannot provide (`docs/DEPLOYMENT.md`). A leader that is alive but stalled, for example frozen in a long garbage collection, keeps its lock and its loops stall with it; a lease row would hand over in that case and a session lock does not. Notifications reach every listening session of the database. Only inserts notify: a task made visible again by a nack, a reclaim or a requeue waits for a poll. A batch of timers is one transaction, so a conflicting append to one of its runs aborts the whole batch, which the next tick repeats. The remaining edges are in `docs/DEFERRED.md`.

## ADR-0065: finished tasks move to a history table in batches, and closed runs are purged per namespace by the elected process

**Context:** day 55 asks that no table grow without bound. `tasks` kept every completed row, and `workflow_task_results`, `step_attempts`, `timers`, `schedule_triggers`, `dead_letters` and `concurrency_slot_history` kept the rows of every run that ever closed (`docs/REVIEW.md`, section 5). The backlog allows finished tasks to be deleted on ack or moved to an append-only history table, asks for retention jobs per namespace for the closed run data, for the history compactor to run on a schedule in the elected process, and for open runs past a size threshold to be compacted only if `docs/REVIEW.md` section 2 still shows their history as unbounded.

**Decision:** finished tasks move to `task_history` (migration 0034), not on ack but in batches: `retire_finished_tasks(before, limit)` deletes up to `limit` `COMPLETED` tasks that settled at or before `before` and inserts them into `task_history` in one statement, oldest first, with `for update skip locked`, so racing calls never move a task twice. A task that still holds a concurrency slot stays. The move happens after a grace period (`finishedTaskGraceMs`, default 30 s) because the dequeue's namespace turn reads `max(lease_seq)` over the lane's tasks, completed ones included (ADR-0059). A first version moved each task in an `after update` trigger at ack time; the turn of a namespace whose tasks were all done then dropped to zero, so the busiest namespace was always served next, and reading the turn from `task_history` as well pushed the dequeue's estimated cost on a fresh database from about 96,000 to 112,000, over `jit_above_cost` (ADR-0062 has the reason that matters). The batch move keeps the ack an update, keeps recent completions where the turn reads them, and moves rows in bulk. `task_history` rejects updates in a trigger, and the view `all_tasks` reads both tables as one, with `COMPLETED` for retired rows; the invariant checker's `task-not-lost` and the chaos progress probe read it.

Closed run data is purged by `purge_closed_runs(namespace, cutoff, limit, now)` (migration 0035), one statement per batch of runs: it marks up to `limit` runs of the namespace that closed at or before the cutoff and have no `purged_at` (`for no key update skip locked`, so the foreign key lock a concurrent `task_history` insert takes on the run does not deadlock with it), deletes their completed tasks first and their task history after, so a task retired meanwhile leaves nothing behind,, and deletes their `workflow_task_results`, `step_attempts`, timers, `schedule_triggers`, requeued dead letters and released concurrency slot history, and the namespace's `SKIPPED` schedule triggers older than the cutoff. The run row, its events, its step results, its snapshot, open dead letters and `BUFFERED` triggers stay. `purged_at` and a partial index on runs that are closed and not purged keep the next sweep from visiting them again. A namespace's retention is its `namespace_retention` row (`setNamespaceRetention`, `null` keeps it forever) or the sweeper's `closedRunRetentionMs`; with neither, nothing is purged, because purging deletes data an operator may want. `createRetentionSweeper` does both jobs, and `startEngine` runs it with `startRetentionLoop` among the leader's loops, on by default for the task move and with `retention: false` to turn it off. `wf worker` takes `--retention s` and `--retention-interval s`. The history compactor already ran among the leader's loops when `compaction` (or `--compact-interval`) is given; a test now shows it runs on the leader only.

The first 30 minute benchmark stalled after a minute: completions fell from about 3,200 in the first minute to under 50 a minute. Each poll took about 140 ms, and nearly all of it was JIT compilation: the dequeue enumerated its lanes from `namespaces`, a table autovacuum never analyzes while it holds a few rows, so the planner assumed 970 namespaces and multiplied every per-lane index probe by that; once the queue had turned over some 30,000 tasks, its bloated indexes made each probe dearer and the estimated cost passed `jit_above_cost` (129,626 in the benchmark, 96,859 in `dequeue-cost.test.ts`, and 73,382 for the same churn without retirement, so the cliff predates this day). Migration 0036 adds `dequeue_lane_namespaces()`, a `plpgsql` function declared `rows 10` that the planner cannot inline, and the dequeue reads its lanes from it; the test now requires the cost to stay below a tenth of the threshold after that churn.

Open runs are not compacted. `docs/REVIEW.md` section 2 lists no unbounded open-run history, and the decision loop replays an open run from its first event, so pruning would need a snapshot of the workflow's own state, which a replay-based engine does not have. A long-lived workflow bounds its history with `ctx.continueAsNew`, and the engine warns when a history passes its threshold (day 19).

**Consequence:** after 10,000 closed runs pass their retention, every listed table holds only the rows of the open runs, and the rows of open runs are byte for byte unchanged (`retention-sweeper.test.ts`, and through the engine in `retention.integration.test.ts`, where the open runs then complete). `tasks` stays flat under a steady load (`docs/BENCHMARKS.md`). A completed task stays in `tasks` for the grace period plus one loop interval, so `tasks` holds that much recent work; reads that want every task use `all_tasks`. Without an elected engine running the loop, completed tasks stay in `tasks` as before. A purged run can no longer be reset or have its decisions re-recorded, its `step_attempts` are gone from the run page, and a backfill over a purged range starts runs again because its `STARTED` triggers are gone. `step_results`, `run_events` (the compactor's job, and day 56's partitions), `run_snapshots` and the run rows still grow with the number of runs.

## ADR-0066: run_events is partitioned by the run's creation day, a partition is archived and dropped once retention purged its runs, and reads can go to a replica

**Context:** day 56 asks that history scale by time and that reads leave the primary: native range partitioning of `run_events` by time with a partition maintainer in the elected process, retention as detach and drop, an archive of each partition in NDJSON before it is dropped that `wf history import` reads back for replay, an optional `DATABASE_READ_URL` for list, history, UI and metrics reads with read-your-writes after a start or signal, and a migration that converts a database with open runs. Day 55 left `run_events` growing with the number of runs; only the compactor shrank it (ADR-0065).

**Decision:** `run_events` is range partitioned on a new column, `run_created_at`, the `created_at` of the event's run (migration 0037), one partition per UTC day (`run_events_pYYYYMMDD`). Partitioning by the event's own time was rejected: a unique constraint on a partitioned table must contain the partition key, so `(run_id, sequence_number)` could no longer be unique across partitions, and that constraint is the last guard of optimistic concurrency (ADR-0007). With the run's creation time as the key, every event of a run lives in one partition, the primary key `(run_id, sequence_number, run_created_at)` is as strong as the old unique pair, and a partition can be dropped as a whole once every run created that day is purged. Every insert path writes the key from the run row: `append_run_events`, `record_step_result`, `record_workflow_task`, `insert_run`, `start_workflow` and the timer scheduler. `append_run_events` now raises `23503` itself for a run that does not exist.

The conversion renames the old table to `run_events_legacy`, fills `run_created_at` from the runs, and attaches it as the partition from `minvalue` to the next UTC midnight, so the events of runs that were open at the migration keep landing there, and creates a default partition and the next seven days. The registry `run_event_partitions` holds every partition's range, archive and drop time. `ensure_run_event_partitions(now, aheadDays)` creates the missing days under an advisory lock, and moves rows that fell into the default partition into their day's partition when it is created.

The foreign key from `run_events` to `workflow_runs` is dropped. Dropping a partition that carries it takes an `ACCESS EXCLUSIVE` lock on `workflow_runs`, and a first version deadlocked with the janitor's stalled-run scan, which holds `workflow_runs` and then asks for `run_events` while the detach held `run_events` and asked for `workflow_runs` (`archive.integration.test.ts` was red in two runs out of six). Every insert path reads the run row to get the partition key, so an event cannot be written for a run that does not exist through the engine, and run rows are never deleted.

The planner cannot prune partitions for an ad hoc statement whose key comes from a subquery, and planning every statement over every partition made a history read about three times slower in a micro benchmark. The hot reads are therefore SQL functions with cached plans, `read_run_events(run, after, limit)` and `run_event_sequence(run)`, which read the run's key first and query one partition.

`createPartitionMaintainer` runs on the elected engine (`partitions`, on by default; `startPartitionLoop` runs it at once and then hourly). It creates `aheadDays` (default 7) partitions ahead, then retires every partition whose range ended more than `settleMs` (default one hour) ago and in which no run is left without `purged_at`. Retirement writes the partition to the archive (`archive`, `archiveDirectory`, or `wf worker --archive-dir`) when one is configured, then detaches and drops it in one transaction with a 5 second `lock_timeout`, after checking that the partition still holds exactly the events it archived; a mismatch, a lock timeout or a failed archive keeps the partition for the next run and is reported. `createDirectoryArchive` writes `<partition>.ndjson` under a temporary name, flushes it and renames it. An archive line holds one event with its run, sequence number, time, event format version and decoded payload, after a header line with the format `dee.run-events-archive`, its version and the partition's range. `readRunEventArchive` and `wf history import <file...> --out <dir>` turn an archive into one history export per run, which `wf replay` and `replayHistories` read. Only `run_events` is partitioned: the other closed-run tables are small per run and day 55's purge already deletes them, and partitioning them would put the same key into every table and every query.

Read routing lives in the run service. With `readPool` (`ApiOptions.readPool`, `wf serve --database-read-url`, or `DATABASE_READ_URL`), run lists, run descriptions, histories and the event stream read the replica, and `/metrics` renders from it. Read-your-writes is kept by the process that wrote: a run it started, signalled, updated, cancelled or terminated is read from the primary for `readYourWritesMs` (default 10 seconds), so is the run list of a namespace after a start, and a run the replica does not know yet is read from the primary. A replay position token passed between processes was rejected for now: it would need the CLI and the UI to carry it, and a single process covers the backlog's case.

**Consequence:** the migration converts a database of 100,000 runs with 200 of them open, the events are byte for byte the same, and the open runs complete afterwards (`partition-migration.integration.test.ts`). Through the engine, the partition of purged runs is archived and dropped, and its archive replays against the workflow code, while a changed workflow fails the replay (`archive.integration.test.ts`). A partition stays as long as one run created that day is not purged, so a namespace without retention, or one long-lived run, keeps its day's partition; continue-as-new moves a long-lived workflow into new days. The legacy partition holds everything from before the migration and is dropped only when all of those runs are purged. Without an elected engine the default partition takes the events of runs created after the seven days the migration made, which works but is never dropped. Reads from a replica may be behind by the replication lag for runs written by another API process, outside the read-your-writes window or for runs another process wrote. The reads that are not hot (the janitor's scan, the invariant checker, the compactor's delete) still plan over every partition.

## ADR-0067: keys carry a scope, an expiry and their last use, admin keys act across namespaces, and admin and operator actions are audited after they succeed

**Context:** day 57 asks that everything which was code only gets an endpoint and a command: an admin API with `wf namespace`, `wf keys` and `wf quota`, keys with the scopes `read`, `operate` and `admin`, an expiry and `last_used_at`, issuing a key without creating its namespace, `wf run terminate`, `wf dlq list|requeue`, a quarantine endpoint, command and UI view, and an audit log of admin and operator actions. Until now every key could do everything in its namespace, and keys, namespaces and quotas were managed from code (`ApiKeyStore`, `createQuotaStore`) or by the flags of `wf serve`.

**Decision:** migration 0038 adds `scope`, `expires_at` and `last_used_at` to `api_keys`. Existing keys become `admin`, the access they had, and the column has no default afterwards, so every insert names a scope. The scopes are ordered, each including the one before it. A route declares the weakest scope it needs: `read` for a `GET`, `operate` for a `POST`, and `admin` for every route under `/v1/admin`; the server checks it right after authentication, before the quota guard and before the body is read, and answers 403 `forbidden` naming the needed scope. The rule is structural rather than a list, so a new route is covered without anyone remembering to list it, and the OpenAPI document shows it as `x-required-scope`. Expiry is checked in the authentication query, so an expired key is answered 401 like an unknown one, and `hasActiveKey` ignores it, so `wf serve` issues a new key for a namespace whose only key expired. `last_used_at` is written only when it is older than a minute (`LAST_USED_RESOLUTION_MS`), so a busy key costs one extra statement per minute instead of one per request.

An `admin` key acts on any namespace: namespaces are a deployment's tenants, and creating one cannot be scoped to a namespace that does not exist yet. A key still belongs to one namespace for its run calls. Namespace-scoped admin keys were rejected for now, since they would need a second notion of admin to create namespaces at all. `issue` and `adopt` no longer create a namespace and reject a missing one with `NamespaceNotFoundError`; `createNamespace` (and `ensureNamespace`, which `wf serve` and `wf dev` call for their own namespace) do.

The audit log is a table, `audit_log`, whose trigger refuses updates and deletes. A route opts in with `audit` (an action name and how to describe the target), and the server appends an entry after the route succeeded, with the calling key copied in as the actor (id, label, namespace, scope), so the entry stays readable after the key is revoked. Writing the entry in the action's own transaction was rejected: the routes call services that manage their own transactions, and threading one client through every service is a larger change than this day. The consequence is that a crash or a failed insert between the action and its entry loses the entry; the failure is logged at `error` and the action stands. Refused and failed requests are not audited, and neither are starts, signals, updates and events, which are application traffic rather than operator actions. The details are the request body; the one response that carries a secret, an issued key, is never copied in.

The quarantine endpoints reuse the janitor's list and release, which now take a namespace so one tenant cannot release another's task. Releasing a workflow task whose run already has a pending one is merged by migration 0031's update trigger, so it never breaks the one-pending-task index. The admin routes live in their own table (`createAdminRoutes`) next to the run routes, with the same `defineRoute`, so they appear in the OpenAPI document and the validator covers them.

**Consequence:** a `read` key is refused every one of the 20 writes with a 403 and changes nothing, an `operate` key is refused all 8 admin routes, an expired key is answered 401, and every audited route's action appears in the log once with its actor (`packages/api/src/admin.test.ts`); the CLI commands run against a real API in `packages/cli/src/admin.integration.test.ts`, and the quarantine page is driven by Playwright in `test/e2e/explorer.e2e.test.ts`. Tests that issued keys for a namespace that did not exist go through `issueTestKey`, which creates it first. An audit entry can be missing after a crash between an action and its entry, and an admin key is as powerful as the database user behind the API.

## ADR-0068: user payloads are encoded per field where they enter the engine and decoded where they leave it, the codec endpoint lives in the API, and the reclaim locks runs before tasks

**Context:** day 58 asks that sensitive data never reaches the database in clear text: one codec path for every payload (events, `step_results`, `tasks.payload`, the run input and result), AES-256-GCM through `node:crypto` with key ids and rotation, a codec endpoint that the UI and CLI call to decode so the server stores only ciphertext, search attributes in clear text, a gzip codec that can be stored with the Postgres store, and masking in logs and the UI. Payloads were written from about fifty statements in fifteen tables, mostly through `JSON.stringify` in each service, and the gzip `Codec` wrote base64 into a `jsonb` column, which Postgres rejected. The day also started with day 57's red CI run: the janitor's reclaim deadlocked with `record_step_result`.

**Decision:** a `PayloadCodec` works on one payload value, not on a whole event or row, and produces a JSON object envelope marked by `$dee_codec`. Encoding happens at the boundaries where a payload enters the engine (the API's run service for starts, signals, signal-with-start, updates, events and schedules, and the worker for decisions, step results and heartbeat details) and decoding where it leaves (the history a decision, query or update replays, a step's input, the codec endpoint). Every store in between keeps the envelope it was handed. This was chosen over encoding in every SQL path because it touches about ten call sites instead of fifty, and a path added later stays covered as long as its value came through a boundary. Encoding whole events or rows was rejected because SQL and the invariant checker read fields such as `payload->>'stepId'`, the queue reads `tasks.payload->>'stepId'`, and visibility reads search attributes; per field, those stay readable. `encodeEventPayloads` and `decodeEventPayloads` hold the one list of which event fields are payloads.

The codec is synchronous, so the decision loop and the live session stay synchronous; `node:crypto` and `node:zlib` have synchronous calls. Encryption is AES-256-GCM with a random 96-bit IV per payload and the key id as additional authenticated data, so swapping the key id of an envelope fails authentication. Rotation is a list of keys and an active id; there is no re-encryption of old payloads. Decoding a value that is not an envelope returns it unchanged, so existing runs and runs written without a codec stay readable when one is turned on.

The codec endpoint (`POST /v1/codec/decode` and `/encode`) is served by the API process, which holds the keys anyway because it encodes what clients send. A separate codec server that only the browser can reach, so the API never sees plaintext, was rejected for now: it would also need client-side encoding in every SDK and in the CLI. Both codec routes are posts that need only a `read` key, the one exception to ADR-0067's rule that a post needs `operate`: they change nothing, and a read-only dashboard key must be able to show what it reads. The API returns stored payloads as they are, and the UI and `wf run describe` call the endpoint to show them, so the decode is one place where masking applies: `maskFields` are replaced by `"[masked]"` in what the endpoint answers, and `createMaskingRedactor` masks the same keys, and every envelope, in log lines.

Errors (`RecordedError`), search attributes and the memo stay in clear text: search attributes and the memo by design, since visibility queries read them, and errors because the engine classifies them by name and the UI shows them without a request. Query answers and update results are returned decoded, since they are computed by the server.

The gzip `Codec` of the event store writes the gzip envelope as JSON, and reads plain events written before it.

The reclaim deadlock: the reclaim locked every expired task and then, through the trigger that merges pending workflow tasks, the task's run. `record_step_result` locks the run and then acks its step task, so under load each waited for the other (the CI Postgres log of run 45588557898 shows both statements). The reclaim now locks the runs of expired leases first, in id order and with `skip locked`, and reclaims only tasks of runs it holds, which is the order every other path takes. A run that is locked is reclaimed on the next sweep.

**Consequence:** with encryption on, a run that uses a step, a heartbeat, a signal, a child workflow, a query, an external event and a schedule leaves the marker of its payloads in none of the rows of any table of the schema, while the same run without a codec is found by the same scan (`packages/worker/src/engine/payload-encryption.integration.test.ts`); a run started under one key completes after the key is rotated, with its old payloads under the old key id and its new ones under the new one (same file). The UI shows decoded and masked payloads only after a request to the codec endpoint (Playwright, `test/e2e/explorer.e2e.test.ts`). The gzip codec round-trips through `run_events` (`event-store.test.ts`). The reclaim no longer deadlocks against a transaction that locked the run and acks its step task (`janitor.test.ts`, red with the old statement). What stays open: payloads written by the SQL function `start_workflow` and by the embedded `startWorkflow` on a caller's client are stored as the caller passes them; `wf replay` of an exported encrypted history does not decode; `wf dev` does not read the codec variables; error messages are not encrypted. They are in `docs/DEFERRED.md`.
