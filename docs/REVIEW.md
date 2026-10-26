# Review after v0.1.0

This file records a code review and a market and technique survey taken after day 30. Six reviews ran in parallel: the core runtime, the worker and durability layer, the API, CLI and UI surface with a security focus, the test suite, CI and packaging, the feature sets of comparable engines, and Postgres scaling and release engineering. Days 31 to 60 of `docs/BACKLOG.md` are planned from it.

The file and line references were correct when the review was written; code moves, so search for the named function if a line does not match. Every finding below is a claim until a test reproduces it. Each backlog day that fixes one starts by writing that failing test.

---

## 1. Release state

- **CI on `main` has been red since day 26.** Every `STATE.md` entry since says `verify` is green, which was true locally only.
  - The `verify` job fails in `test/e2e/explorer.e2e.test.ts` because the Chromium path `/opt/pw-browsers/chromium` exists only in the agent sandbox.
  - The `docker` job fails its smoke step with curl exit 22 (an HTTP error, most likely `/ready` answering 503). The job prints container logs only on success, so a failure leaves no diagnostics.
  - Only the `examples` job passes.
- **`explorer.e2e.test.ts` is flaky locally in two ways.**
  - `count()` assertions do not wait (`:209`).
  - `pump()` appends with a stale `expectedSeq` while the UI's signal POST races it, giving the day 29 `ConcurrencyError`.
- **Timeouts and real-time waits.**
  - No `testTimeout` or `hookTimeout` is set in `vitest.config.ts`, so the 5 second default cuts off polling helpers that allow up to 15 seconds.
  - About 27 test files wait on real time despite the fake clock rule. The worst is `examples/hello/src/hello.integration.test.ts:27`.
- **Type stripping is not protected by the compiler.** `erasableSyntaxOnly` is not set, so an `enum` or a parameter property would pass `tsc` and crash `wf` at runtime.
- **Package resolution.**
  - The `@dee/*` mapping is defined in four places: the vitest aliases, the tsconfig `paths`, `packages/cli/src/runtime/resolve-hooks.ts`, and the package `main` fields. The `main` fields point at a `dist` that is never built.
  - Publishing raw TypeScript cannot work, because Node refuses to strip types under `node_modules`.
- **Release leftovers.**
  - The `v0.1.0` tag is not on `origin`.
  - The licence is `UNLICENSED`.
  - `format:check` is not part of `verify`.

## 2. Correctness of the core runtime

1. **`ctx.now()`, `ctx.random()` and `ctx.uuid()` are read live on every replay** (`packages/core/src/workflow/decision-loop.ts:451-459`, `live-session.ts:250-252`). No event records them, so `ctx.step("x", { id: ctx.uuid() })` raises `NonDeterminismError` on the next decision. `docs/CONCEPTS.md:33` claims the opposite.
2. **The non-determinism check compares a live input with a JSON-decoded copy** using `isDeepStrictEqual` (`decision-loop.ts:254,329`, `live-session.ts:189`). Inputs holding `undefined`, a `Date`, `NaN` or `-0` fail on replay.
3. **Replay resolves every recorded result before the handler starts** (`decision-loop.ts:277,345,402`). Promise order then follows call order, not history order, so code that reacts to a signal in a `.then()` takes a different branch on replay.
4. **The sandbox patches only `Date.now`, `Math.random` and `setTimeout`** (`sandbox.ts:71-79`).
   - `new Date()`, `performance.now()`, `crypto.randomUUID`, `setInterval` and `setImmediate` pass through.
   - A non-`ctx` promise that resolves after quiescence pushes commands into a list already consumed, and the run hangs.
5. **Changes that emit no new command go undetected.**
   - Timers are matched by id only, so a changed duration passes.
   - Recorded commands that the new code no longer issues are not checked, so removing a trailing step completes the run silently.
6. **A step can record two terminal results.**
   - `recordStepResult` deduplicates on `(run_id, step_id, attempt_key)` only (`idempotency/recorder.ts:198-224`).
   - The "already recorded" check runs outside the transaction (`retry/step-task-processor.ts:119-125,152`).
   - A slow attempt that lost its lease and a later successful retry both append. Cold replay then takes the first result and the sticky session the last.
7. **Workflow timeouts do nothing.** `enforceWorkflowTimeout` (`retry/timeout.ts:78-101`) is never called. If it were, it appends without closing the run.
8. **Errors lose information or are dropped.**
   - A step that exhausts its retries is dead-lettered and the workflow waits forever: workflow code cannot catch the failure to compensate.
   - `step_failed` keeps only the name and message (`recorder.ts:147`).
   - Compensation errors are swallowed (`decision-loop.ts:524-528`).
9. **Integrity errors retry instead of failing.** `NonDeterminismError`, `VersionMismatchError` and synchronous handler throws are nacked and retried until quarantine.
10. **The gzip codec cannot be stored.** It produces base64 that is inserted as `jsonb`. Separately, `step_results`, `tasks.payload` and the run input and result bypass the codec, so size limits and masking never reach them.
11. **Smaller issues.**
    - `queryRun` on a compacted run throws `RunNotFoundError`.
    - `sleep(NaN)` or a negative duration throws a `RangeError`.
    - Continue-as-new drops signals the run never consumed.

## 3. Correctness of the worker and durability layer

1. **Poison tasks spin with no backoff.**
   - `startEngine` never sets `nackDelayMs` (`packages/worker/src/engine/runtime.ts:94-105`, `worker.ts:279`), so an unknown workflow, a zod failure or a persistent database error redelivers on every poll.
   - Quarantine counts only lease expiries, so it never sees these tasks.
2. **Quarantine is bypassed while workers poll.** `dequeue` takes expired leases directly (`packages/core/src/queue/task-queue.ts:168`) without raising `reclaim_count`; only the janitor raises it. A task that crashes its worker goes straight to the next one.
3. **Runs that are legitimately waiting are re-decided every sweep.** The stalled predicate (`recovery/janitor.ts:156-165`) matches every run waiting on a signal, a child or a dead-lettered step. Each such run gets a full replay on every sweep, forever.
4. **Runs have no queue.**
   - `workflow_runs` has no queue column. Timers, stalled recovery, schedules, signals and cancels enqueue to the component's own queue.
   - With two worker pools, tasks land on the pool that lacks the workflow.
   - `close-run.ts` and `continued-run.ts` find the queue from the oldest task row, so tasks can never be pruned.
5. **Pool deadlock.** `ensureStepTasks` holds a client inside a transaction and calls `queue.enqueue`, which takes a second client (`task-handler.ts:304-325`). With concurrency at or above the pool size, and no acquire timeout, the pool deadlocks.
6. **Mixed clocks.**
   - Lease time, visibility and the extend check use the worker's wall clock (`task-queue.ts:150,194,234`). A host that runs fast takes live leases.
   - The stalled check compares the client clock with the database's `now()`.
7. **A step keeps running after its lease is lost.**
   - The `AbortSignal` is never passed to step handlers (`step-task-processor.ts:137`).
   - A shutdown timeout nacks a task whose handler is still running (`worker.ts:386-395`), so another worker starts the same step at once.
   - A failing `extend` lets the task run on with an expired lease.
8. **Cron catch-up fires every missed instant** (`schedules/schedule-manager.ts:402`). An invalid cron or time zone silently disables the schedule (`:191-196`).
9. **Adding to the dead letter queue and acking are two steps** (`step-task-processor.ts:204-214`). A crash between them runs the step one more time than `maxAttempts`.
10. **Broken connections go back to the pool.** 20 `pool.connect()` call sites release without `client.release(error)`.
11. **Sticky routing is built but never wired.** `createStickyRouter` and `stickyFor` are unused, so with N workers the replay cache hits about 1/N of the time.

## 4. API, CLI and UI

1. **The production image runs `wf dev`.**
   - Every restart issues a new key that never expires, prints it to stdout and writes it to `.wf/dev.json` with default permissions.
   - The bundled examples are loaded and the logger is silent.
   - Tracing, quotas and the compactor are off.
2. **`migrateUp` takes no lock** (`packages/core/src/db/migrator.ts:73-101`), so replicas that start together race.
3. **SSE has no limits.** There is no per-namespace stream cap and no maximum lifetime, and each open stream runs two queries every 500 ms (`packages/api/src/server.ts:246-306`).
4. **Unlogged errors.** 500s are never logged (`server.ts:426-439`), and a malformed percent-encoding is a 500 instead of a 400 (`server.ts:127`).
5. **Metrics.**
   - `/metrics` is unauthenticated and runs six full-table aggregates per scrape (`packages/core/src/observability/engine-metrics.ts:105-157`).
   - `dee_task_latency_seconds` and `dee_leases_reclaimed_total` are never filled by a bundled process.
6. **Unbounded responses.**
   - Dead letters are loaded for every namespace and filtered in memory (`run-service.ts:528-541`).
   - Run history has no limit or cursor.
7. **Unthrottled 401s.** Unauthenticated requests cost a database query and are never throttled.
8. **API keys have no lifecycle.** They have no expiry, no `last_used_at` and no scopes, and issuing one silently creates a namespace.
9. **Masking is documented but not done.** `maskSensitiveFields` is described in `docs/DEPLOYMENT.md:66`, but nothing calls it.
10. **Smaller issues.**
    - The UI timeline duplicates events after a stream reconnect (`apps/ui/src/client/run-view.ts:162-195`).
    - The `workflow.start` span leaks on the duplicate and error paths.
    - The CLI does not encode run ids in URLs.
    - `wf worker` can spawn `docker compose` in production.
    - The UI CSP lacks `frame-ancestors`, `base-uri` and `form-action`.
    - Log fields can override `level`, `time` and `message`.
    - Starting a run accepts any workflow type.

Clean on review: namespace isolation on every route, idempotency keys scoped per namespace, the 1 MB body limit, XSS in the UI, the key in `sessionStorage`, and no CORS.

## 5. Scalability levers

- **Statements per run.** About 47 statements per run are the measured limit. Fold the hot paths into single statements or functions: enqueue step tasks inside the decision's transaction, merge reads, and record the step result, ack and enqueue the workflow task in one transaction. Target 10 to 15.
- **Duplicate workflow tasks.** A fan-out of N steps costs N full replays. Add a partial unique index on pending workflow tasks per run.
- **Batching.** Batch acks and heartbeats.
- **Polling and timers.**
  - Use LISTEN/NOTIFY as a wake-up hint with polling kept as the fallback, behind a flag, on a dedicated connection.
  - Every engine process runs the timer, schedule and janitor loops; elect a leader through an advisory lock.
  - Fire timers in batches.
- **Unbounded tables.**
  - `tasks` keeps every completed row.
  - `workflow_task_results`, `step_attempts`, `timers`, `schedule_triggers`, `dead_letters` and `run_events` grow without bound.
  - The compactor is not scheduled by any process.
  - Delete or move finished tasks, add retention jobs, then partition `run_events` by time.
- **Hot updates.** A heartbeat bumps the indexed `visible_at`, so no lease update can be HOT.
- **Read replicas.** Visibility reads and the metrics scrape can move to a read replica.
- **PgBouncer.** Transaction mode already works with the engine's transaction-scoped advisory locks. Document it.

## 6. Features that comparable engines treat as table stakes

The engines compared are Temporal, Restate, Inngest, DBOS, Hatchet, Trigger.dev, Cloudflare Workflows, Vercel Workflow, Absurd, pgflow, graphile-worker and pg-boss. Ranked:

1. Concurrency keys with per-key fairness, where waiting runs hold no slot.
2. Rate limits enforced in the database.
3. Priorities.
4. Transactional enqueue from application code: the strongest differentiator of a Postgres-native engine.
5. `waitForEvent` with a correlation key and a timeout, plus callback tokens.
6. Workflow updates.
7. Search attributes, memo and a visibility filter.
8. Reset and fork from a step.
9. Batch operations by filter.
10. Step heartbeats with details and step timeouts.
11. Workflow run timeouts.
12. Debounce, singleton and dedup keys with a TTL.
13. Streamed step output for AI agents.
14. A payload codec with encryption and a codec endpoint.
15. Replay testing tooling.
16. Worker deployment versioning.
17. Retention and archival.
18. Pause and resume.
19. Event batching.
20. Keyed stateful entities.

The positioning this suggests: Temporal semantics on Postgres alone, library-first, with transactional enqueue as the headline feature, multi-tenant flow control, and the operability tooling that hobby Postgres queues lack.

## 7. Release engineering

- **Licence.** Apache-2.0 is recommended for infrastructure because of its explicit patent grant. The choice is the owner's.
- **Build.** Ship ESM only, built with `tsc -b` and `rewriteRelativeImportExtensions`, with `exports` maps that ship `migrations/*.sql`. Check each release with `publint` and `@arethetypeswrong/cli`.
- **Versioning.** Use changesets with one fixed version group.
- **Publishing.**
  - npm trusted publishing via OIDC with provenance.
  - A GHCR image built for amd64 and arm64 with SBOM and provenance, tagged by semver.
  - A release workflow triggered by tags.
- **Stability policy.** On 0.x a minor version may break, a patch must not. The history event format and the migrations are forward-compatible only, gated by a replay fixture suite.
- **Other languages.** Start with client-only SDKs generated from OpenAPI, then a step-only worker SDK over long-poll task endpoints. Full workflow SDKs in other languages wait until the history format is frozen.
