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

## ADR-0015: error serialization is a standalone utility, not a change to `FailRunCommand`'s existing shape

**Context:** day 7 asks for error serialization that preserves a thrown
error's type, message and stack across a store-and-reload cycle. Day 6's
handoff note pointed at `step_failed`'s error reconstruction in
`decision-loop.ts` (`{ name, message }`, with no stack) as the natural
place to extend. Extending it in place, though, means changing what
`runDecisionLoop` actually puts on a `fail_run` command's `error` field:
every existing hand-built history fixture and `decision-loop.test.ts`/
`run-workflow.test.ts` assertion that does `toEqual({ name, message })` on
that field would start failing the moment a real error's (always present)
`stack` shows up as an extra key, for a behavior no "done when" from day 4
through day 6 actually asked to change.

**Decision:** `serializeError`/`deserializeError` (`workflow/error-serialization.ts`)
are a self-contained pair: `serializeError` reduces an `Error` to
`{ name, message, stack? }`, `deserializeError` rebuilds a plain `Error`
from that shape. Neither `runDecisionLoop` nor `runWorkflowInMemory` is
changed to call them for `fail_run`/`step_failed` construction today — that
wiring is for whichever future day actually persists a step's thrown error
(day 10's idempotent step result recording is the first candidate).
`stepFailedEventSchema` and `runFailedEventSchema` do gain an optional
`stack` field on `error` now, since that is additive: every existing
fixture and hand-built event omits it and still validates.

**Consequence:** the "done when" (a custom error class's type and message
survive a serialize/read-back cycle, stack included) is proven directly
against the utility's own tests, with no ripple into `commands.ts` or any
existing decision-loop/run-workflow test. The cost is that today's engine
does not yet actually attach a stack to any event it produces; that lands
whenever step execution is wired into a real event write, not before.

---

## ADR-0016: the payload size limit, compression and masking hooks all live on `Codec`'s construction options, checked in that order

**Context:** day 7 asks for a payload size limit with an explicit error, a
compression hook, and a sensitive-field masking hook, all on the existing
`Codec` seam from day 3. `Codec` itself (`encode`/`decode`) is used
directly by `createPostgresEventStore`, so adding parameters to `encode`
would touch the event store too; the seam that should change instead is
how a `Codec` is built.

**Decision:** `createJsonCodec(options?)` replaces a bare object literal
as `jsonCodec`'s constructor, taking `maxPayloadBytes` (default 1 MiB),
`compress`/`decompress`, and `sensitiveFields`. `encode` applies masking
first (walking the value recursively, replacing any object key in
`sensitiveFields` with a fixed `"[redacted]"` marker, at any depth), then
`JSON.stringify`s the masked value, then `compress` (if given), then
measures the *final* string's UTF-8 byte length against `maxPayloadBytes`
and throws `PayloadTooLargeError` if it is over. Masking runs before
compression and is applied to the value that actually gets persisted, not
to a separate logging-only view: a masked field is gone from the stored
payload entirely, so a later replay can never recover its original value.
The size check runs last, against what compression actually produced,
since that is the number of bytes the `payload` column will hold — a
payload that is over the limit before compression but under it after
should not be rejected.

**Consequence:** `jsonCodec` (`createJsonCodec()` with every option at its
default) keeps its exact prior behavior, so day 3's event store tests are
untouched. `PayloadTooLargeError` carries both the actual byte length and
the configured limit, so a caller can tell whether raising the limit or
shrinking the payload is the fix. The masking hook is a real redaction,
not a display filter: choosing to mask a field is choosing that no code
path, including a future replay, ever sees that field's real value again.

---

## ADR-0017: `defineStep` validates and times out a step, but nothing yet makes a worker call it

**Context:** day 7's "step execution contract" (`defineStep`, an
input/output schema, a timeout field) has no worker to run inside yet —
that is day 11. `StepRegistry.register` already existed as the seam a
worker would use to look a step up by `stepType`, but it stored a bare
`StepHandler` with no schema or timeout attached, matching day 4's own
note that a step's input "is not actually checked against anything at the
call site".

**Decision:** `defineStep` returns a `StepDefinition` whose `execute`
wraps the handler: it parses the raw input against an optional zod
`inputSchema` before the handler ever runs, races the handler against an
optional `timeoutMs` with `Promise.race`-style logic (rejecting with a new
`StepTimeoutError` if the timer wins), and parses the handler's return
value against an optional `resultSchema` before handing it back. A
schema's own validation error (a `ZodError`) is left to propagate
unwrapped, since it identifies itself as a schema failure without help.
`registerStep(registry, definition)` adapts a `StepDefinition` onto the
existing `StepRegistry.register(stepType, handler)` seam, so a worker that
only ever calls `registry.get(stepType)` does not need to know whether the
handler behind it came from `defineStep` or a bare function.
`StepDefinition` is generic only in its result type, matching
`WorkflowContext.step<TResult>`'s existing precedent (day 4): a step's
input always arrives as `unknown` off the wire or a replayed history, so a
compile-time-only input type parameter would type-check a call site
without checking anything real.

**Consequence:** a step's timeout does not cancel the handler's actual
work — there is no cooperative cancellation for an arbitrary async
function — it only stops `execute` from waiting on it, exactly the same
limitation `StepTimeoutError`'s own doc comment states. A worker built on
top of this in a later day still needs its own logic for what to do with
an attempt that timed out but might still complete in the background
(day 9's task visibility timeout and day 13's retry policy are the
natural places that gets handled).
