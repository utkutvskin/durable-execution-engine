# State

Every session updates this file per A1 and A2. The newest entry sits at the top. Each entry must be readable on its own, with no need to consult the previous day's note.

Field glossary:

- **Day:** the day number in the backlog.
- **Status:** `IN_PROGRESS` | `DONE` | `BLOCKED`.
- **Completed day:** when this entry is written at close, the last day number that reached DONE. The next session computes its own day number from here.
- **Files added or changed:** a short list.
- **Technical decisions:** references to any ADRs added to `docs/DECISIONS.md`.
- **BLOCKER:** when filled in, the next session clears this before anything else. Otherwise `-`.
- **Handoff note:** the one line that must not be forgotten tomorrow.

---

## Day 6: non-determinism detection and the replay test harness

- **Status:** DONE
- **Completed day:** 6
- **Files added or changed:** `packages/core/src/event-store/events.ts` (`stepScheduledEventSchema` gains a required `stepType` field), `packages/core/src/workflow/errors.ts` (new, `NonDeterminismError`), `packages/core/src/workflow/sandbox.ts` (new, `ForbiddenApiError` and `guardAgainstForbiddenApis`), `packages/core/src/workflow/decision-loop.ts` (compares each `ctx.step()` call against its recorded `step_scheduled` event, runs the handler under the forbidden-API guard, rethrows `NonDeterminismError`/`ForbiddenApiError` instead of reporting them as `fail_run`), `packages/core/src/workflow/decision-loop.test.ts` and `packages/core/src/event-store/event-store.test.ts` (fixtures updated for the new `stepType` field, 8 new tests), `packages/core/src/index.ts` (re-exports `NonDeterminismError`, `ForbiddenApiError`), `test/fixtures/workflows/ship-order.ts` (new, the example workflow shared by the fixtures), `test/fixtures/histories/*.json` (4 new recorded-history fixtures), `test/replay-history-harness.test.ts` (new, runs every fixture as a batch), `docs/DECISIONS.md` (ADR-0012, ADR-0013, ADR-0014)
- **Technical decisions:** ADR-0012, ADR-0013 and ADR-0014 in `docs/DECISIONS.md`. ADR-0012: `step_scheduled` events now carry `stepType`, so a replayed `ctx.step()` call can be compared against what history actually recorded for that `stepId` (via `node:util`'s `isDeepStrictEqual` on `input`, plain `!==` on `stepType`); a mismatch throws `NonDeterminismError`, and both it and `ForbiddenApiError` are rethrown out of `runDecisionLoop` directly rather than folded into a `fail_run` command, since they mean the decision itself cannot be trusted, unlike a genuine handler rejection. ADR-0013: the forbidden-API sandbox patches `Date.now`/`Math.random`/`setTimeout` with a reference count rather than a per-call save/restore, because `runDecisionLoop` can run concurrently (day 5's own "three consecutive replays" test drives it with `Promise.all`) and a naive save/restore corrupts global state permanently once two guarded calls overlap — caught directly by that existing test breaking a later, unrelated test in the same file once the sandbox was wired in. ADR-0014: recorded history fixtures are plain JSON under `test/fixtures/histories/`, replayed through a small `workflowType` → handler map in the harness, so they exercise the same already-serialized shape a real event store read would hand back rather than hand-built TypeScript values. No new dependency (`node:util`'s `isDeepStrictEqual` is a Node built-in, not a package).
- **BLOCKER:** -
- **Handoff note:** `pnpm install && pnpm run verify` is green (25 test files, 85 tests, 13 of them new today). The `dee` role/database again did not survive the container restart and were recreated by hand (`CREATE ROLE dee WITH LOGIN PASSWORD 'dee' SUPERUSER; CREATE DATABASE dee OWNER dee;`), same as every prior day. Proven by test: a workflow that swaps which step type it calls at a given `stepId`, or that keeps the step type but changes the input, both throw `NonDeterminismError` carrying the `stepId` and the expected/found `{stepType, input}`; a workflow that calls `Date.now()`, `Math.random()` or `setTimeout()` directly (after at least one `await`, so the guard is proven to hold across a tick, not just synchronously) rejects with `ForbiddenApiError`, and the globals are proven restored afterward even though the failure path throws; the reference-counted guard is proven safe under the exact concurrent-`Promise.all` pattern day 5 already exercises. Day 7 (step execution contract and payload codec) is next: `defineStep`, a step timeout field, error serialization preserving type and stack, a payload size limit with a compression hook on `Codec`, and a sensitive-field masking hook — none of today's files need to change for that, though `step_failed`'s `error` reconstruction in `decision-loop.ts` (currently just `{name, message}`) is the natural place day 7's richer error serialization will plug into if the stack needs to survive replay too.

---

## Day 5: decision loop and replay engine

- **Status:** DONE
- **Completed day:** 5
- **Files added or changed:** `packages/core/src/workflow/decision-loop.ts` and its `decision-loop.test.ts`, `packages/core/src/index.ts` (re-exports `runDecisionLoop`, `DecisionLoopOptions`, `DecisionResult`), `docs/DECISIONS.md` (ADR-0011)
- **Technical decisions:** ADR-0011 in `docs/DECISIONS.md` (quiescence is detected with one `setImmediate` tick rather than a counted `await Promise.resolve()` loop, since a macrotask boundary is Node's own guarantee that every microtask a promise chain can still produce has run; a step or timer with no result yet is served a promise whose executor never calls `resolve`/`reject`, so nothing is ever left scheduled to leak into a later tick). No new dependency.
- **BLOCKER:** -
- **Handoff note:** `pnpm install && pnpm run verify` is green (24 test files, 72 tests, 8 of them new today). `runDecisionLoop` re-runs a workflow handler from the start against a given `readonly WorkflowEvent[]` history: `ctx.step()`/`ctx.sleep()` calls whose `step-N`/`timer-N` id already has a `step_completed`/`step_failed`/`timer_fired` event resolve straight from that event, calls whose id is already `step_scheduled`/`timer_started` but not yet finished stay pending with no new command, and a call with no matching event at all gets a new `schedule_step`/`start_timer` command pushed and then stays pending too — so `commands` on the returned `DecisionResult` only ever holds what this particular decision newly discovered, never anything already implied by the history it was given. It never looks a step type up in a `StepRegistry` and never runs a step's body: that is deliberate, since replay's only job is to answer "what is the next command", not to perform the side effect the command asks a worker to perform. Proven by test: three consecutive decisions over the same fixed history produce byte-for-byte identical `commands` arrays; a history with 2 of 3 steps complete produces only the third step's `schedule_step` command; a step already `step_scheduled` but not yet completed produces no command at all (same for a timer already `timer_started`); a `step_failed` event's `{name, message}` is reconstructed into a real `Error` and propagates as the run's `fail_run`; two `setImmediate` ticks after the loop returns, its `commands` array is unchanged, which is the closest a test gets to directly proving "no micro-task leak" from outside. Same sandbox-setup note as day 3 and day 4 stands: the `dee` role/database did not survive the container restart and were recreated by hand again this session. Day 6 (non-determinism detection and the replay test harness) is next: it needs to run a decision twice — once against the recorded command from history, once as a fresh `runDecisionLoop` decision — and raise `NonDeterminismError` the first time they diverge at a given sequence position; the `commands`-only-contains-what's-new shape this day settled on is exactly what that comparison diffs against, so it should carry over unchanged, and the `test/fixtures/histories/*.json` harness day 6 asks for can be built directly on top of the `WorkflowEvent` arrays this day's tests already construct by hand.

---

## Day 4: workflow dsl and command model

- **Status:** DONE
- **Completed day:** 4
- **Files added or changed:** `packages/core/src/workflow/{commands,context,sources,step-registry,workflow-registry,define-workflow,run-workflow}.ts` and their `*.test.ts` files, `packages/core/src/index.ts` (re-exports the workflow module's public api), `docs/DECISIONS.md` (ADR-0009, ADR-0010)
- **Technical decisions:** ADR-0009 and ADR-0010 in `docs/DECISIONS.md` (workflows and steps are registered by name in a `WorkflowRegistry`/`StepRegistry` rather than passed as closures, so day 5's replay engine can serve a completed step's result by `stepId` without needing to reconstruct a closure; `runWorkflowInMemory` resolves every `ctx.step()` and `ctx.sleep()` call in one straight pass with no suspension, which is deliberately as far as today's scope goes — day 5 wraps this runner with the history-driven decision loop, it does not replace it). No new dependency.
- **BLOCKER:** -
- **Handoff note:** `pnpm install && pnpm run verify` is green (23 test files, 64 tests, 16 of them new today). The three-step `ship-order` example workflow in `run-workflow.test.ts` exercises `ctx.step()` three times and `ctx.sleep()` once and asserts the exact `schedule_step` / `start_timer` / `complete_run` command sequence; a second test spies on `Date.now`/`Math.random` to prove `ctx.now()`/`ctx.random()` only ever read from the injected `ClockSource`/`RandomSource`, never the global. `WorkflowContext.step()` is generic only in its result type (`step<TResult>(stepType, input: unknown)`), not its input type — `@typescript-eslint/no-unnecessary-type-parameters` rejected a type parameter used only in the parameter position, and a step's input is not actually checked against anything at the call site anyway since the registry pairs the type with the handler only at `register()` time, not at every `ctx.step()` call. Same sandbox-setup note as day 3 stands: the `dee` role/database did not survive the container restart and were recreated by hand again this session; the next session should expect to do the same unless the sandbox image changes. Day 5 (decision loop and replay engine) is next: it needs to feed in a recorded history, serve completed steps' results from it instead of calling `steps.get(stepType)` and executing directly, and stop at the first incomplete point — `runWorkflowInMemory`'s straight-through `ctx.step()`/`ctx.sleep()` implementation in `run-workflow.ts` is exactly the piece that logic replaces the inside of, not the `WorkflowContext`/command/registry surface around it, which should carry over unchanged.

---

## Day 3: event store and optimistic concurrency

- **Status:** DONE
- **Completed day:** 3
- **Files added or changed:** `packages/core/src/event-store/{events,codec,errors,event-store}.ts` and their `*.test.ts` files, `packages/core/src/index.ts` (re-exports the event store's public api), `packages/core/package.json` (new `zod` dependency), `docs/DECISIONS.md` (ADR-0007, ADR-0008)
- **Technical decisions:** ADR-0007 and ADR-0008 in `docs/DECISIONS.md` (optimistic concurrency via a sequence-number precheck plus the existing unique constraint, no extra locking; `Codec` converts to/from the wire string rather than the value `pg` would already parse). Dependency added: `zod`, named explicitly by day 3's scope ("schema validation (zod)") for the `workflowEventSchema` discriminated union — not a dependency choice made outside the day's own scope, per A5.
- **BLOCKER:** -
- **Handoff note:** `pnpm install && pnpm run verify` is green (18 test files, 48 tests, 15 of them new today, including a 50-parallel-attempt stress test asserting exactly one `EventStore.append` wins a race on the same `expectedSeq` and the other 49 get `ConcurrencyError`). The event catalog in `events.ts` (`run_started`, `run_completed`, `run_failed`, `step_scheduled`, `step_completed`, `step_failed`, `timer_started`, `timer_fired`) is deliberately just the lifecycle events the store itself needed to be exercised against; day 4's workflow DSL and command model will likely need to extend or reshape this set, which is expected and fine. Same sandbox-setup note as day 2 stands: this container has no Docker daemon, so postgres is the natively installed `service postgresql start` on `localhost:5432`, and its `dee` role/database do not survive a container restart — the next session should check `service postgresql status` and recreate the `dee`/`dee`/`dee` role and database by hand (matching `.env.example`) if they are missing before trusting a red `pnpm run verify` as a real failure.

---

## Day 2: database schema and migration infrastructure

- **Status:** DONE
- **Completed day:** 2
- **Files added or changed:** `packages/core/migrations/0001_initial_schema.{up,down}.sql`, `packages/core/src/db/{migrator,env,cli,test-harness}.ts` and their `*.test.ts` files, `packages/core/package.json` (new `pg`/`@types/pg` dependencies, `migrate:up`/`migrate:down` scripts), root `package.json` (`migrate:up`/`migrate:down` scripts delegating to `@dee/core`), `docs/DECISIONS.md` (ADR-0005, ADR-0006), `README.md` (a "Database" section documenting the migration commands)
- **Technical decisions:** ADR-0005 and ADR-0006 in `docs/DECISIONS.md` (a hand-written SQL migration runner instead of `node-pg-migrate`; integration tests each open their own randomly named Postgres schema instead of Testcontainers). Dependency added: `pg` plus its `@types/pg` types, the standard node postgres client — needed by the migration runner and by every database-backed package from here on, not something to hand-roll per A5.
- **BLOCKER:** -
- **Handoff note:** `pnpm install && pnpm run verify` is green (15 test files, 33 tests, 15 of them new today). `pnpm run migrate:up` / `migrate:down` were run by hand against a real database twice each and confirmed idempotent (second `up` reports "nothing to do", second `down` too), matching the day's "done when". Day 1's Docker worry turned out to be bigger than diagnosed: this sandbox has no Docker daemon at all (`docker compose up -d` fails with "connect: no such file or directory" on `/var/run/docker.sock`, not just a registry block), so `docker compose up -d` still cannot be run here. What unblocked today is that Postgres 16 is natively installed in this sandbox image; `service postgresql start` brings it up on `localhost:5432`, and the `dee`/`dee`/`dee` role, password and database from `.env.example` were created by hand to match. Nothing in the code depends on Docker specifically — `resolveDatabaseUrl` and the test harness only need a reachable Postgres, compose or otherwise — so this is a sandbox-setup fact for the next session, not a code change. CI is unaffected either way: `.github/workflows/ci.yml` already runs `postgres:16` as an unrestricted GitHub Actions service container (day 1), which is what `pnpm run verify`'s integration tests actually run against there. The next session should still confirm CI is green on the pushed commit before trusting this further, and, if it lands in a fresh sandbox without a preinstalled Postgres either, will need to either get Docker working or find another local Postgres before day 3's event-store tests can run.

---

## Day 1: monorepo skeleton and CI

- **Status:** DONE
- **Completed day:** 1
- **Files added or changed:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`, `README.md`, `docs/DECISIONS.md`, `docs/OUT_OF_SCOPE.md`, `packages/{core,worker,api,cli}`, `apps/ui`, `examples/README.md`, `test/tooling/*`
- **Technical decisions:** ADR-0001 through ADR-0004 in `docs/DECISIONS.md` (workspace layout, shared strict tsconfig, eslint strictness, postgres only via compose/CI service container)
- **BLOCKER:** -
- **Handoff note:** `pnpm install && pnpm run verify` is green (11 test files, 18 tests). `docker compose up -d` was not run to completion in this session: the sandbox's egress policy blocks Docker Hub pulls (`403` on `production.cloudfront.docker.com`, confirmed as a policy denial via the agent proxy status, not a transient failure). `docker compose config` validates the file's syntax and resolved defaults without pulling. GitHub Actions CI pulls `postgres:16` as an unrestricted service container, so this should not block CI; the next session should confirm CI is actually green on the pushed commit before trusting this further. Day 2 (database schema and migrations) is the first day that needs postgres to actually be reachable — if the same pull restriction holds there, it needs handling in the failure protocol at that point, not this one.

---

## Day 0 (bootstrap)

- **Status:** DONE
- **Completed day:** 0
- **Files added or changed:** `docs/BACKLOG.md`, `STATE.md`, `docs/CONVENTIONS.md`, `CLAUDE.md`
- **Technical decisions:** -
- **BLOCKER:** -
- **Handoff note:** Start from day 1 (monorepo skeleton and CI). Read `docs/CONVENTIONS.md` before you start; A1 step 2 is mandatory.
