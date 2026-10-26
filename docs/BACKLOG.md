# Durable Execution Engine: Development Backlog

This file lives at `docs/BACKLOG.md`. Each session reads this file, then `STATE.md`, does only that day's scope, then commits and pushes.

The backlog has 60 days. Days 1 to 30 built v0.1.0. Days 31 to 60 build v0.2 and continue straight on from day 30: a session whose last `DONE` entry in `STATE.md` says `Completed day: 30` works on day 31.

**Stack (fixed):** TypeScript (strict), Node 22, PostgreSQL 16, pnpm workspaces, Vitest, Docker Compose.
**Monorepo packages:** `packages/core`, `packages/worker`, `packages/api`, `packages/cli`, `apps/ui`, `examples/`.

---

## SECTION A: AGENT OPERATING INSTRUCTIONS

### A1. Session start sequence (every day, no exceptions)

1. `git checkout main && git pull --ff-only`
2. Read `docs/CONVENTIONS.md` in full. It defines the owner's standing writing and commit preferences. This step is never skipped: it must happen before writing any commit message, PR description, code or document. Where this file and the backlog disagree on how something is written, `docs/CONVENTIONS.md` wins.
3. Read the most recent entry in `STATE.md`. If the `BLOCKER` field is filled in, clearing that blocker is the first and highest-priority task of the day. Do not move on to the day's own scope before the blocker is cleared.
4. Find today's day number in `docs/BACKLOG.md` (the last completed day in `STATE.md` + 1). Read only that day's block.
5. Verify the baseline: `pnpm install && pnpm run verify`. If it is red, the first task of the day is turning the baseline green, and that is written into `STATE.md`.
6. Split the day's scope into 3-6 subtasks, write them into `STATE.md` as `IN_PROGRESS`, do not commit.

### A2. Session close sequence

1. `pnpm run verify` must be green (lint + typecheck + unit + integration).
2. Each of that day's "Done when" items must have a test or a runnable command that proves it. An item without proof does not count as complete.
3. Update `STATE.md`: the completed day, the files added, the technical decisions taken, the blocker if there is one, the note handed off to tomorrow.
4. If a new architectural decision was taken, add it to `docs/DECISIONS.md` in ADR format (Context / Decision / Consequence).
5. Make the commits, push to `main`. No `day-NN` tag: this repository does not use daily tags, `STATE.md`'s `Completed day` field and the commit history are the record of progress. This does not apply to the release tags: `v0.1.0` on day 30, `v0.1.1` on day 40 and `v0.2.0` on day 60.

### A3. Commit rules

- Conventional commits: `feat(core): ...`, `fix(worker): ...`, `test(api): ...`, `chore(ci): ...`, `docs: ...`
- Commit messages, PR text, and documents follow `docs/CONVENTIONS.md` — English, lowercase, no AI attribution line.
- 2-6 commits per day. A single giant commit is forbidden, and so is a single-line cosmetic commit.
- Every commit must compile and pass the tests on its own.
- The last commit of the day always contains the `STATE.md` update and its message is `chore(state): day NN complete`.
- `git push --force` and history rewrites are strictly forbidden.

### A4. Failure protocol

If the day's scope is not finished, do not push broken code to `main`. Instead:

1. Commit the work to a `wip/day-NN` branch and push that branch.
2. On `main`, commit only the `STATE.md` update: write into the `BLOCKER` field what you got stuck on, in which file, which test is red, and the two approaches you tried.
3. Do not advance the day number. The next session continues with the same day number and picks the work back up from the `wip/day-NN` branch.
4. If the same day is blocked twice in a row, reduce that day's scope to the smallest working vertical slice, move the rest into `docs/DEFERRED.md`, and close it that way.

### A5. Scope discipline

- Do not do tomorrow's work today. If the day finishes early, pick from the spare task pool in section C.
- Do not loosen or delete the "Done when" items of previous days. If a criterion is wrong, write an ADR with the rationale into `docs/DECISIONS.md`, then change it.
- What is in `docs/OUT_OF_SCOPE.md` is not done in v0.1: distributed consensus, a custom storage engine, gRPC, a Kubernetes operator, multi-region.
- Do not commit secrets or credentials. Only `.env.example` is updated.
- Before adding a new third-party dependency, write the rationale into `STATE.md`. Prefer an existing package for cryptography, date/time and the queue; write the core runtime logic yourself.

### A6. Quality bar

- No feature without a test. At least 5 meaningful new tests are added every day.
- Every time-related test uses a fake clock, no test waits with `sleep`.
- Integration tests run against a real Postgres (Testcontainers or an ephemeral schema on compose).
- Using `any` is forbidden, use `unknown` + narrowing. `@ts-expect-error` only on a line that carries its reason.
- Every function added to the public API has a TSDoc comment.
- No comments inside function bodies. TSDoc on exported symbols is required and does not count as one. See section 3 of `docs/CONVENTIONS.md`.

---

## SECTION B: THE BACKLOG, DAYS 1-30 (v0.1)

### PHASE 1: FOUNDATION (Days 1-3)

#### Day 1: Monorepo skeleton and CI

**Goal:** An empty but fully set up development environment.
**Scope:** pnpm workspaces, TypeScript strict config, ESLint + Prettier, Vitest setup, `docker-compose.yml` (Postgres 16), the `pnpm run verify` script (lint + typecheck + test), GitHub Actions CI, `.env.example`, a `README.md` skeleton, the initial `STATE.md` and `docs/DECISIONS.md` files.
**Done when:** On a clean checkout, `pnpm install && docker compose up -d && pnpm run verify` comes back green in one go. CI runs on push and is green.
**Commit:** `chore(repo): bootstrap monorepo`, `chore(ci): add verify pipeline`

#### Day 2: Database schema and migration infrastructure

**Goal:** The shape of the persistence layer.
**Scope:** Your own simple migration runner or `node-pg-migrate`. Tables: `namespaces`, `workflow_runs`, `run_events`, `tasks`, `timers`, `step_results`. Indexes and constraints: unique on `run_events(run_id, sequence_number)`, a partial index on `(state, visible_at)` on `tasks`. Test harness: a helper that opens an isolated schema for every test file.
**Done when:** `pnpm migrate:up` and `pnpm migrate:down` run idempotently. When two test files run at the same time they do not see each other's data (isolation test).
**Commit:** `feat(core): database schema and migrations`

#### Day 3: Event store and optimistic concurrency

**Goal:** An append-only event log, the single source of truth.
**Scope:** The `EventStore` interface: `append(runId, expectedSeq, events[])`, `read(runId, fromSeq)`. A discriminated union for event types and schema validation (zod). `ConcurrencyError` on a conflict. A `Codec` interface for payload serialization (v0: JSON).
**Done when:** Of two concurrent appends with the same `expectedSeq`, exactly one succeeds and the other gets a `ConcurrencyError` (stress test with 50 parallel attempts). The event log is never updated or deleted on any code path.
**Commit:** `feat(core): append-only event store with optimistic concurrency`

---

### PHASE 2: RUNTIME CORE (Days 4-8)

#### Day 4: Workflow DSL and command model

**Goal:** The API surface the user will write against.
**Scope:** `defineWorkflow`, `ctx.step()`, `ctx.sleep()`, `ctx.now()`, `ctx.random()`, `ctx.uuid()`. Command types: `ScheduleStep`, `StartTimer`, `CompleteRun`, `FailRun`. A registry for workflow and step registration. No persistence yet, everything in memory.
**Done when:** A three-step example workflow runs in memory and produces the correct command sequence. `ctx.now()` and `ctx.random()` do not call `Date.now()` and `Math.random()` directly, they are fed from an injected source (proven by a test).
**Commit:** `feat(core): workflow dsl and command model`

#### Day 5: Decision loop and replay engine

**Goal:** Rebuilding state from the event log.
**Scope:** Decision loop: feed in the history, run the workflow function from the start, serve the results of completed steps from the history, stop at the first incomplete point and collect the new commands. Put the promise scheduler into a deterministic order (there must be no micro-task leak).
**Done when:** Three consecutive replays over the same history produce an identical command sequence. Given a partial history (2 of 3 steps complete), only the third step's command is produced.
**Commit:** `feat(core): deterministic replay decision loop`
**Forbidden:** Do not touch persistence today, the input is still the in-memory history array.

#### Day 6: Non-determinism detection and the replay test harness

**Goal:** Making silent corruption impossible.
**Scope:** Comparison of the command produced during replay against the record in the history, `NonDeterminismError` on a mismatch (at which sequence, what was expected and what was found). `test/fixtures/histories/*.json` for recorded history fixtures and a harness that runs them as a batch. A sandbox check that catches forbidden API usage (a direct `Date`, `Math.random` or `setTimeout` call inside a workflow must raise an error).
**Done when:** When deliberately modified workflow code is replayed against an old history, it throws an explanatory `NonDeterminismError`. An example that calls `Date.now()` in a workflow body is tested and rejected.
**Commit:** `feat(core): non-determinism detection`, `test(core): recorded history harness`

#### Day 7: Step execution contract and payload codec

**Goal:** Side effects (activities) in a defined and portable form.
**Scope:** Input/output schema via `defineStep`, a step timeout field, error serialization (including the stack, preserving its type), a large payload limit and a compression hook on `Codec`, a sensitive field masking hook.
**Done when:** When the custom error class thrown by a step is serialized and read back, its type and message are preserved. A payload over 1 MB gives an explicit `PayloadTooLargeError`.
**Commit:** `feat(core): step contract and payload codec`

#### Day 8: Run projection and state machine

**Goal:** Readable run state from the event log.
**Scope:** The `workflow_runs` projection, states: `RUNNING`, `COMPLETED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `TERMINATED`. A table of permitted transitions, an error on an invalid transition. The projection being rebuildable from the event log from scratch (`rebuildProjection`).
**Done when:** When the projection table is deleted entirely and rebuilt from the event log, it is identical to its previous state (property-based test, 200 random event sequences). A new command cannot be applied to a run in a terminal state.
**Commit:** `feat(core): run projection and state machine`

---

### PHASE 3: DISTRIBUTION AND DURABILITY (Days 9-13)

#### Day 9: Task queue

**Goal:** Distributing the work to the workers.
**Scope:** Dequeue with `SELECT ... FOR UPDATE SKIP LOCKED`, visibility timeout, `enqueue` / `ack` / `nack` / `extend`, task types (`WORKFLOW_TASK`, `STEP_TASK`), a namespace-based task queue name.
**Done when:** When 8 parallel consumers process 1000 tasks, no task is handed to two consumers at the same time and none is lost. A task that is not acked becomes visible again after the visibility timeout.
**Commit:** `feat(core): task queue with skip-locked dequeue`

#### Day 10: Idempotency and the single-write guarantee

**Goal:** Correctness under at-least-once delivery.
**Scope:** A `(run_id, step_id, attempt_key)` unique constraint on `step_results`, the step result and the event write being atomic in a single transaction, returning the existing result on redelivery, the same protection on workflow tasks as well.
**Done when:** When the same step task is deliberately delivered 5 times, exactly one result is written to the event log no matter how many times the step body runs. A write cut off in the middle of a transaction leaves no partial record.
**Commit:** `feat(core): idempotent step result recording`

#### Day 11: Worker process, lease and heartbeat

**Goal:** Holding long-running work safely.
**Scope:** The worker poll loop, a concurrency limit, lease renewal via heartbeat, `WorkerOptions` (queue, concurrency, poll interval), backoff while waiting on an empty queue, graceful shutdown (on SIGTERM take no new tasks, finish the current ones, drop them on timeout).
**Done when:** A 60-second step that heartbeats is not handed over to another worker despite a 10-second visibility timeout. After SIGTERM the running tasks complete and the process exits cleanly (exit code 0).
**Commit:** `feat(worker): poll loop, lease renewal and graceful shutdown`

#### Day 12: Crash recovery

**Goal:** The engine's real promise.
**Scope:** A janitor task that reclaims orphaned leases, worker identity and version stamp, detection of runs left half-finished, recovery metrics, a test infrastructure that sets up `SIGKILL` scenarios (starting the worker as a separate process and killing it).
**Done when:** A second worker takes over the work of a worker killed with `SIGKILL` right in the middle of a step and finishes the flow with the correct result. In a 20-repetition chaos test all runs reach a terminal state, none is left lost.
**Commit:** `feat(worker): crash recovery and lease reclaim`

#### Day 13: Retry policies and dead letter

**Goal:** Predictable behavior in the face of errors.
**Scope:** `RetryPolicy` (initialInterval, backoffCoefficient, maxInterval, maxAttempts, jitter), `NonRetryableError`, step-level and workflow-level timeout, attempts being written to the event log, the `dead_letters` table and a requeue function.
**Done when:** Backoff intervals are asserted against the expected values with a fake clock. `NonRetryableError` is never retried. A step that exhausts its maximum attempts lands in the DLQ and can be requeued manually.
**Commit:** `feat(core): retry policies and dead letter queue`

---

### PHASE 4: TIME AND CONTROL FLOW (Days 14-18)

#### Day 14: Durable timers

**Goal:** `ctx.sleep()` in its genuinely durable form.
**Scope:** The `timers` table, the scheduler tick loop, a due timer turning into a workflow task, catch-up for the time that passed while the system was down, monotonic protection against clock drift and time going backwards.
**Done when:** In a run containing a 10-minute `sleep`, when the engine is shut down completely and brought back up 10 minutes later, the run advances immediately (with a fake clock). 500 overdue timers are processed in the correct order at startup.
**Commit:** `feat(core): durable timers and scheduler`

#### Day 15: Scheduled and recurring workflows

**Goal:** Cron capability.
**Scope:** The `schedules` table, cron expression parsing, time zone support, overlap policy (`skip`, `buffer_one`, `allow_all`), pause/resume, backfill of past triggers.
**Done when:** A `*/5 * * * *` definition starts exactly 12 runs when the fake clock is advanced by 1 hour. With the `skip` policy a new run does not start before the previous one finishes. A paused schedule never triggers.
**Commit:** `feat(core): cron schedules`

#### Day 16: Signals and queries

**Goal:** Interacting with a running run from the outside.
**Scope:** The `signalRun` API and its recording as an event, `ctx.waitForSignal(name)`, signal buffering (a signal that arrives while the run is not yet waiting is not lost), the first-completed wait via `ctx.select()`, side-effect-free point-in-time state reads via `queryRun`.
**Done when:** A signal sent before the run enters the wait is delivered when the run starts waiting. `select` branches to whichever of the two waits completes first and picks the same branch on replay. A query call writes nothing to the event log.
**Commit:** `feat(core): signals, buffering and queries`

#### Day 17: Cancellation and compensation (saga)

**Goal:** Reversible workflows.
**Scope:** The distinction between `cancelRun` and `terminateRun` (graceful vs hard), the cancellation scope and its propagation to substeps, `ctx.onCancel()` and compensation registration, waiting for the running step during cancellation, `CancelledError` semantics.
**Done when:** A cancelled saga runs the registered compensation steps in reverse order and closes in the `CANCELLED` state. `terminate` moves to `TERMINATED` immediately without running compensation. No new step is enqueued after cancellation.
**Commit:** `feat(core): cancellation scopes and compensation`

#### Day 18: Child workflows and fan-out/fan-in

**Goal:** Composition.
**Scope:** `ctx.startChild()` and `ctx.executeChild()`, the parent-child relationship and `parentClosePolicy`, a deterministic equivalent of `all` / `allSettled` for parallel steps, an upper bound on the number of children and backpressure.
**Done when:** A fan-out/fan-in run with 100 children completes with the correct aggregate result. When the parent is cancelled, the children with `parentClosePolicy: cancel` are cancelled too, while those with `abandon` keep running.
**Commit:** `feat(core): child workflows and parallel execution`

---

### PHASE 5: SCALE AND EVOLUTION (Days 19-21)

#### Day 19: continue-as-new and history compaction

**Goal:** Keeping the history of endlessly running workflows from bloating.
**Scope:** `ctx.continueAsNew(input)`, run chain and `first_run_id` tracking, a history size/event count threshold and warning, snapshot writing for old runs and event pruning (with a retention policy).
**Done when:** A 10,000-iteration loop workflow runs with constant memory and constant history size. The whole chain can be queried by a single `first_run_id`. After pruning, replay from the snapshot gives the correct result.
**Commit:** `feat(core): continue-as-new and history compaction`

#### Day 20: Sticky execution and replay cache

**Goal:** Performance: not replaying from scratch on every task.
**Scope:** A per-worker run cache (LRU), routing the same run to the same worker via a sticky queue, falling back to a full replay on a cache miss, sticky timeout and cache invalidation.
**Done when:** For a 500-step workflow, the total number of replays with the sticky cache on is at least 80% below the off state (measured with a benchmark test). When the cache is deliberately flushed, the result does not change.
**Commit:** `feat(worker): sticky execution cache`

#### Day 21: Workflow versioning

**Goal:** Being able to change the code without breaking running runs.
**Scope:** `ctx.patched(patchId)` and `ctx.deprecatePatch(patchId)`, writing patch decisions to the event log, the worker build id stamp, safe rejection on a version mismatch, a versioning guide document.
**Done when:** Runs that started on v1 code and were left half-finished complete without a `NonDeterminismError` once v2 code is deployed (proven with recorded history fixtures). New runs use the v2 branch.
**Commit:** `feat(core): workflow versioning with patch gates`

---

### PHASE 6: PRODUCT SURFACE (Days 22-26)

#### Day 22: HTTP API and authentication

**Goal:** Opening the engine to the outside.
**Scope:** The `startRun`, `signalRun`, `cancelRun`, `terminateRun`, `describeRun`, `listRuns`, `getHistory` endpoints. API key auth, namespace isolation (a mandatory tenant filter on every query), an idempotency key for start, OpenAPI schema generation.
**Done when:** Accessing namespace B's run with namespace A's key returns 404 (a test for every endpoint). Two `startRun` calls with the same idempotency key create a single run. The OpenAPI output passes schema validation.
**Commit:** `feat(api): rest endpoints with namespace isolation`

#### Day 23: Quotas, rate limiting and backpressure

**Goal:** Preventing the noisy neighbor problem.
**Scope:** A per-namespace rate limit (token bucket), concurrent run and pending task quotas, `429` and `Retry-After` on quota overrun, worker poll backpressure based on queue depth, poison pill protection (if the same task kills a worker N times, quarantine it).
**Done when:** A namespace that exceeds its quota gets `429` while another namespace keeps running unaffected. A task that keeps crashing the worker is quarantined after 3 attempts and does not block the queue.
**Commit:** `feat(api): quotas, rate limiting and poison pill protection`

#### Day 24: Distributed tracing

**Goal:** End-to-end visibility of a run.
**Scope:** OpenTelemetry integration, step and timer spans under the workflow span, carrying the trace context from the start call to the worker and to child workflows, not producing fake spans during replay, the sampling setting.
**Done when:** A run containing a child workflow appears in Jaeger as a single unbroken span tree (verified against the Jaeger set up with compose). Replayed steps do not produce duplicate spans.
**Commit:** `feat(observability): opentelemetry tracing`

#### Day 25: Metrics, logs and health endpoints

**Goal:** Operational readiness.
**Scope:** Prometheus metrics (queue depth, task latency histogram, retry rate, timer lag, active worker count, run state counters), structured JSON logs and correlation ids, the `/health` and `/ready` endpoints, an example Grafana dashboard JSON.
**Done when:** The `/metrics` output parses in Prometheus format and contains the expected 8 metrics (by test). With Postgres down, `/ready` returns 503 and `/health` returns 200. The dashboard JSON is in the repo.
**Commit:** `feat(observability): metrics, structured logs and health probes`

#### Day 26: Web UI

**Goal:** Observability through human eyes.
**Scope:** A run list (status, namespace, date, workflow type filters, pagination), a timelined event history on the run detail, an input/output/error viewer, live updates via SSE, sending a signal from the UI, cancellation and requeue from the DLQ.
**Done when:** A running workflow is seen advancing in the UI without a page refresh, branches on a signal sent from the UI, and can be cancelled from the UI (end-to-end test with Playwright).
**Commit:** `feat(ui): run explorer with live updates`

---

### PHASE 7: HARDENING AND RELEASE (Days 27-30)

#### Day 27: Chaos tests and the invariant checker

**Goal:** Proving correctness.
**Scope:** Fault injection suite: worker kill, DB connection loss and recovery, double delivery, shifting the clock forward and backward, slow disk simulation, network latency. Invariant checker: every run is either terminal or advancing, an unacked task is not lost, a step result is never written twice, the projection is consistent with the event log.
**Done when:** Each of the 6 failure scenarios runs 10 repetitions and there are zero invariant violations. The report is written into `docs/CHAOS_REPORT.md`.
**Commit:** `test(chaos): fault injection suite and invariant checker`

#### Day 28: Performance measurement and tuning

**Goal:** Speaking in numbers.
**Scope:** Benchmark harness (runs started per second, steps completed per second, end-to-end p50/p95/p99 latency), connection pool and batch size tuning, an index review for hot queries and `EXPLAIN ANALYZE` evidence, batching on event writes.
**Done when:** There are baseline figures measured on a single node and written into `docs/BENCHMARKS.md`. At least one concrete bottleneck has been identified and fixed, and the improvement shown with a before/after number.
**Commit:** `perf(core): query and batching optimizations`, `docs: benchmark results`

#### Day 29: CLI and example applications

**Goal:** Developer experience.
**Scope:** CLI: `wf dev` (Postgres + api + worker + ui in a single command), `wf worker`, `wf run start|signal|cancel|describe|list`, `wf migrate`. Two complete examples: a payment saga (reservation, capture, compensation) and an ETL pipeline (batch processing with fan-out, retry, cron).
**Done when:** On a clean machine `npx wf dev` brings the environment up and both examples run end to end with a single command. The examples' own tests run in CI.
**Commit:** `feat(cli): developer commands`, `docs(examples): payment saga and etl pipeline`

#### Day 30: Documentation, packaging and v0.1.0

**Goal:** A releasable product.
**Scope:** README (a 5-minute quick start), `docs/ARCHITECTURE.md` (with diagrams), `docs/CONCEPTS.md` (determinism, versioning, retry, idempotency), the API reference, production deployment notes, a multi-stage Dockerfile and the published image, `CHANGELOG.md`, the semver tag `v0.1.0`, `docs/ROADMAP.md`.
**Done when:** Someone seeing the repo for the first time can run a workflow in 5 minutes by following only the README (the steps verified in a clean container). The `v0.1.0` tag and the release note are published.
**Commit:** `docs: architecture and concepts`, `chore(release): v0.1.0`

---

## SECTION B, CONTINUED: DAYS 31-60 (v0.2)

Days 31 to 60 are planned from the review in `docs/REVIEW.md`. Read the section a day names before starting it. Every day that fixes a reviewed bug starts by writing the test that reproduces it, red, before touching the code. A bug that does not reproduce is recorded in `STATE.md` with the test that shows it, not silently skipped.

### PHASE 8: STABILIZATION (Days 31-40)

#### Day 31: Green CI and honest verification

**Goal:** CI on `main` is green and stays the measure of a finished day.
**Scope:**

- The e2e test reads Chromium from `PLAYWRIGHT_CHROMIUM_PATH`, and CI installs a browser for it. Locally the test is skipped with a visible message when no browser exists. It is never skipped in CI.
- Fix the two flakes in `test/e2e/explorer.e2e.test.ts`: waiting assertions instead of `count()`, and `pump()` retrying on `ConcurrencyError`.
- The `docker` job fails loudly when the health loop times out, and prints `docker logs` and the `/ready` body on failure. Fix the cause it reveals.
- Set `testTimeout` and `hookTimeout` in `vitest.config.ts`.
- Turn on `erasableSyntaxOnly`.
- Add `format:check` to `verify`.
- Move the actions to their current major versions.
- Add a step to A2: the session reads the CI result of its pushed commit through the GitHub tools, and a red CI run is a `BLOCKER`.
- Replace the real-time waits listed in `docs/REVIEW.md` section 1 with fake clock or event-driven waits, starting with `examples/hello`.
  **Done when:** Every CI job is green on the pushed commit, read back from GitHub. The e2e file passes 20 consecutive local runs. `grep` finds no `setTimeout`-based wait left in the files listed in the review, or each remaining one is named in `docs/DEFERRED.md` with its reason.
  **Commit:** `fix(ci): run the browser test and diagnose the image job`, `test: remove real-time waits`

#### Day 32: Deterministic context values and a tighter sandbox

**Goal:** Every value a workflow reads is the same on replay.
**Scope:**

- `ctx.now()` returns the time of the event that triggered the decision.
- `ctx.random()` and `ctx.uuid()` come from a PRNG seeded by the run id and a per-run counter, or from recorded marker events. The choice goes in an ADR.
- The non-determinism comparison compares canonical codec encodings, not `isDeepStrictEqual` on a live object.
- The sandbox also patches `Date` itself, `performance.now`, `crypto.randomUUID`, `setInterval` and `setImmediate`.
- A decision fails with a clear error when workflow code is still active after quiescence.
- Correct `docs/CONCEPTS.md` where it described recorded values.
  **Done when:**
- A run that calls `ctx.uuid()`, `ctx.random()` and `ctx.now()` and feeds them into step inputs completes through 5 decisions, with the system clock and random source, on both the cold and the sticky path.
- Inputs holding `undefined`, a `Date` and `-0` replay without `NonDeterminismError`.
- Each newly patched global has a test that proves it is refused inside a decision and works outside one.
  **Commit:** `fix(core): deterministic now, random and uuid on replay`, `fix(core): close sandbox gaps`

#### Day 33: Replay in history order and complete command matching

**Goal:** Replay takes the same path as the live run for every recorded history.
**Scope:**

- Feed recorded results to the handler in history order, draining microtasks between events, the way the live session does.
- Match all commands (step, timer with its duration, child, patch) in one ordered sequence.
- Fail the decision when recorded commands are left that the new code did not issue.
- Add a property-based test (fast-check) that generates workflows and event orderings and asserts that cold replay, sticky replay and the live run agree.
  **Done when:** Tests prove all of these:
- A signal handled in `.then()` before an awaited step takes the same branch live and on replay.
- A changed timer duration, a step swapped for a sleep, and a removed trailing step each raise `NonDeterminismError`.
- The property test runs 500 generated cases with no disagreement.
  **Commit:** `fix(core): replay events in history order`, `test(core): property test of replay equivalence`

#### Day 34: One terminal result per step and atomic step enqueue

**Goal:** No step ever has two terminal events, and no step waits on the janitor after a crash.
**Scope:**

- Under the run row lock, `recordStepResult` refuses a second terminal result for `(run_id, step_id)`. Back this with a unique index.
- Move the "already recorded" check into that transaction.
- Make dead-lettering and the ack one transaction.
- Enqueue the `STEP_TASK` of a `step_scheduled` event in the same transaction as the event. This closes the `docs/DEFERRED.md` entry.
- Remove the second client from `ensureStepTasks`.
- Release a client with `client.release(error)` on every failure path.
- Give the pool an acquire timeout.
  **Done when:**
- A test with a slow attempt 1 that lost its lease, a failed attempt 1 and a successful attempt 2 ends with exactly one terminal event, and cold and sticky replay agree.
- A crash injected between recording a decision and the old enqueue no longer delays the step.
- An engine with concurrency twice the pool size completes 50 runs with no deadlock.
- A client whose connection died is not reused.
  **Commit:** `fix(core): a step records one terminal result`, `fix(worker): enqueue step tasks in the decision transaction`

#### Day 35: Poison tasks, quarantine and idle runs

**Goal:** A bad task costs bounded work, and a run that is waiting costs no work.
**Scope:**

- Exponential nack delay from `task.attempts`, configurable in `startEngine`.
- A task that fails its handler N times is quarantined.
- `dequeue` counts a reclaimed lease and quarantines at the threshold.
- `NonDeterminismError`, `VersionMismatchError` and an unknown workflow type follow a documented policy: fail the run, or park the task for an operator. Write an ADR.
- The janitor tells a stalled run apart from one waiting on a signal, a child or a dead-lettered step, through a `waiting_on` marker or a `last_progress_at` column, with backoff on repeated recovery.
  **Done when:**
- A handler that always throws is retried with growing delays and quarantined after N tries.
- A task that crashes its worker is quarantined while two other workers are polling.
- Over 10 simulated minutes, a run waiting on a signal enqueues zero workflow tasks.
- A really stalled run is still recovered.
  **Commit:** `fix(worker): back off and quarantine poison tasks`, `fix(core): janitor ignores runs that are waiting`

#### Day 36: Queue routing, database time and step cancellation

**Goal:** Work goes to the pool that owns it, a lease means the same on every host, and a lost lease stops the step.
**Scope:**

- Add `queue_name` to `workflow_runs`.
- Timers, stalled recovery, schedules, signals, cancels, close and continue-as-new all enqueue to the run's queue. The scanning loops filter by queue.
- Lease, visibility and extend use the database's time.
- The step `AbortSignal` reaches step handlers. A failed heartbeat past the visibility timeout aborts the step. A shutdown timeout aborts before it nacks.
- Schedules get a catch-up policy (`latest_only` by default, `all` within a window).
- An invalid cron or time zone is reported as an error state, not as a silently disabled schedule.
  **Done when:**
- Two engines on different queues share one database and each run's timers, signals and recoveries reach only its own queue.
- A worker whose clock runs 30 seconds fast does not take a live lease.
- A hanging step is aborted when its lease is lost and does not run twice at the same time.
- A per-minute schedule offline for one simulated day starts one run under `latest_only`.
  **Commit:** `fix(core): route every task by the run's queue`, `fix(worker): abort steps that lost their lease`

#### Day 37: Workflow timeouts and failure propagation

**Goal:** A workflow can bound its own lifetime and react to a step that failed for good.
**Scope:**

- A run timeout and an execution timeout, driven by a durable timer. They are recorded through the recorder and close the run with `closeRunIfTerminal`, notifying the parent.
- A step that exhausts its retries raises a typed `StepFailedError` inside the workflow, so the workflow can compensate. Keep the dead letter entry for the operator; record the policy in an ADR.
- `step_failed` keeps the error type, `cause` and serializable details.
- Compensation errors are recorded, not swallowed.
- `sleep` rejects `NaN` and negative durations with a clear error.
- `queryRun` works on a compacted run.
  **Done when:** Tests prove all of these:
- A run with a 1 hour timeout on a fake clock ends `TIMED_OUT` and its parent sees it.
- A workflow catches an exhausted step and runs its compensation.
- A custom error class survives the round trip with its details.
- A failing compensation is visible in the history.
  **Commit:** `feat(core): run timeouts and catchable step failure`

#### Day 38: API, UI and CLI hardening

**Goal:** The reviewed surface defects from `docs/REVIEW.md` section 4 are closed.
**Scope:**

- **API:**
  - SSE gets a per-namespace stream cap and a maximum lifetime.
  - 500s are logged with the correlation id.
  - A malformed percent-encoding answers 400.
  - Unauthenticated requests are throttled per client address.
  - History and dead letters are paginated with a cursor, and dead letters are filtered by namespace in SQL.
  - `/metrics` is cached for a configurable interval and can require a bearer token.
  - The `workflow.start` span is ended on every path.
  - Starting a run validates the workflow type when a registry is given.
  - JSON responses get `nosniff`.
- **UI:**
  - The timeline deduplicates by sequence number.
  - The CSP gets `frame-ancestors`, `base-uri` and `form-action`.
  - Cancel and requeue ask for confirmation.
- **CLI:**
  - Run ids are encoded in URLs.
  - Non-JSON errors are reported without a stack trace.
  - `--wait` honours 429 and `Retry-After`.
  - `--limit` is validated.
- **Logger:** core fields cannot be overridden, and a redaction hook exists.
- **Masking:** either wire `maskSensitiveFields` into the API and the UI, or correct `docs/DEPLOYMENT.md`.
  **Done when:** Each item has a test. A flood of 1,000 unauthenticated requests costs a bounded number of queries. A dropped stream reconnects without duplicate timeline entries (Playwright).
  **Commit:** `fix(api): bound streams, log failures, paginate`, `fix(ui): dedupe timeline and tighten csp`

#### Day 39: Production entry points

**Goal:** Running the engine in production does not mean running `wf dev`.
**Scope:**

- `wf serve`: the API without a worker. It takes the key from the environment or an existing key, and logs structured JSON.
- Flags on `wf serve` and `wf worker`: pool size, log level and format, tracing endpoint, quotas, the history compactor schedule, and a health and metrics port for a worker.
- `migrateUp` takes an advisory lock.
- `wf worker` and `wf migrate` never start compose when `NODE_ENV=production`.
- `wf migrate down` asks for confirmation.
- `.wf/dev.json` is written with mode 0600.
- Wire `onTaskSettled` and recovery metrics in `startEngine`, so `dee_task_latency_seconds` and `dee_leases_reclaimed_total` fill.
- Wire the sticky router into `startEngine`.
- The Dockerfile's default command becomes `wf serve`. Compose gets separate `api` and `worker` services.
- Rewrite `docs/DEPLOYMENT.md` to match.
  **Done when:**
- Two `wf migrate up` processes started together both succeed.
- `wf serve` plus two `wf worker` processes complete the payment saga, and every one of the 8 metrics has a non-empty series.
- With 3 workers, the sticky hit rate in a benchmark run is above 80 percent.
- The docker CI job runs the split services and passes.
  **Commit:** `feat(cli): serve command and production flags`, `fix(core): lock migrations`

#### Day 40: Chaos on the engine runtime and v0.1.1

**Goal:** The fixes of days 32 to 39 are proven under faults, then released as a patch.
**Scope:**

- The chaos suite drives `startEngine` and real workflows, not only the recorder.
- New scenarios: a slow attempt racing a retry, two queues on one database, clock skew between workers, a pool smaller than concurrency, and a run waiting on a signal (the checker learns to tell waiting from stalled).
- A nightly CI workflow runs the suite.
- Update `docs/CHAOS_REPORT.md` and `CHANGELOG.md`.
- Tag `v0.1.1` and push the tag.
- Push the missing `v0.1.0` tag as well, if the owner has not.
  **Done when:** Each scenario, old and new, runs 10 seeded repetitions against the engine runtime with zero invariant violations. The nightly workflow has run once green. `git ls-remote --tags origin` lists `v0.1.1`.
  **Commit:** `test(chaos): drive the engine runtime`, `chore(release): v0.1.1`

---

### PHASE 9: DISTRIBUTION AND ADOPTION (Days 41-44)

#### Day 41: A built distribution

**Goal:** The packages can be installed and run outside this repository.
**Scope:**

- **Licence:** already chosen: Apache-2.0 (ADR-0041), with `LICENSE`, `NOTICE` and the `license` field in place since v0.1.0. Check that the packed packages carry `LICENSE` and `NOTICE`.
- **Build:** `tsc -b` to `dist` with declarations and `rewriteRelativeImportExtensions`, ESM only.
- **Exports:**
  - `exports` maps with a `development` condition pointing at `src`, so the `@dee/*` mapping lives in one place and the vitest aliases, the tsconfig `paths` and the resolve hook go away.
  - `migrations/*.sql` and the UI assets are included in `files`.
- **Checks:** `publint` and `@arethetypeswrong/cli` run in CI.
  **Done when:**
- `pnpm pack` of every package, installed into an empty directory outside the repository with `npm install`, runs `npx wf dev` against a Postgres and completes the hello workflow. This runs in CI in a clean `node:22` container, closing the two `docs/DEFERRED.md` entries about it.
- `publint` and `attw` report no error.
  **Commit:** `build: compile packages to dist`, `chore(ci): check the packed packages`

#### Day 42: Release pipeline

**Goal:** A tag produces a release without anyone typing commands by hand.
**Scope:**

- Changesets with one fixed version group.
- A tag-triggered workflow that runs `verify`, then:
  - publishes to npm with trusted publishing and provenance;
  - builds the image for amd64 and arm64 with SBOM and provenance and pushes it to GHCR under semver tags;
  - creates the GitHub release from the `CHANGELOG.md` section.
- The image runs from `dist`.
- Document the steps the owner must take once (npm scope, trusted publisher, GHCR visibility) in `docs/RELEASING.md`.
  **Done when:** The workflow runs green in dry-run mode on a pre-release tag: every step except the final npm publish and GHCR push executes. The steps that need the owner's accounts are listed in `docs/RELEASING.md` and in `STATE.md`.
  **Commit:** `chore(ci): tag-triggered release pipeline`

#### Day 43: Embedded mode and transactional enqueue

**Goal:** An application can start a workflow atomically with its own writes. This is the headline feature from `docs/REVIEW.md` section 6.
**Scope:**

- `startWorkflow(client, ...)`, `signalWorkflow(client, ...)` and `cancelWorkflow(client, ...)` take a caller's open transaction. The run row, its events and its first task commit or roll back with the application's writes.
- A SQL function `dee.start_workflow(...)` lets triggers and non-Node code enqueue.
- A `schema` option places the engine tables next to the application's.
- An example (`examples/outbox/`) shows an order insert and a workflow start in one transaction.
- `docs/EMBEDDING.md`.
  **Done when:**
- A rolled-back transaction leaves no run, event or task behind.
- A committed one runs to completion.
- The SQL function starts a run that completes.
- The engine passes its integration suite with a non-default schema.
  **Commit:** `feat(core): transactional workflow start`, `docs(examples): outbox example`

#### Day 44: Stability policy and replay testing tools

**Goal:** Users can change workflow code safely, and the project says what it will not break.
**Scope:**

- `docs/STABILITY.md`:
  - semver on 0.x;
  - the public API (package exports, `/v1`, CLI flags, the database schema and the history event format);
  - deprecation rules.
- A version field on history events, with forward-compatible reading.
- `wf history export <runId>`.
- `wf replay --module <path> <file...>`, plus a `replayHistories` test helper that replays exported histories against new code and reports non-determinism.
- A fixture suite of recorded histories from every earlier day runs in CI as a gate.
- An API report (`@microsoft/api-extractor`) catches accidental export changes.
  **Done when:**
- A workflow change that breaks determinism makes `wf replay` exit non-zero, naming the run and the event.
- A compatible change passes.
- The fixture gate fails when an event schema changes incompatibly.
  **Commit:** `feat(cli): history export and replay`, `docs: stability policy`

---

### PHASE 10: AUTHORING API (Days 45-48)

#### Day 45: Workflow updates and queries over HTTP

**Goal:** A validated, synchronous write into a running workflow that returns a result.
**Scope:**

- `defineUpdate` with a validator and a handler.
- `update_accepted` and `update_completed` events.
- `POST /v1/runs/{id}/updates/{name}` waits for the result with a timeout.
- A rejected update leaves no event.
- `GET /v1/runs/{id}/queries/{name}`.
- `wf run update` and `wf run query`.
- OpenAPI, `docs/API.md`, the UI form.
  **Done when:**
- An update that passes validation returns its result over HTTP and replays deterministically.
- A rejected update returns 400 and writes nothing.
- A query returns current state without writing an event.
- Concurrent updates are applied in a defined order.
  **Commit:** `feat(core): workflow updates`, `feat(api): update and query endpoints`

#### Day 46: Events, conditions and signal semantics

**Goal:** Waiting on the world, not only on one run id.
**Scope:**

- `ctx.waitForEvent(name, { match, timeout })` with events addressed by a correlation key.
- Events that arrive early are buffered for a configurable period.
- `POST /v1/events`.
- Event-triggered starts.
- `ctx.condition(fn, timeout)`.
- Signal deduplication ids.
- Signal-with-start.
- Continue-as-new carries unconsumed signals into the new run.
  **Done when:**
- An event sent before the run waits is delivered.
- A timeout fires on a fake clock.
- An event with a matching key starts a run.
- A duplicate signal id is applied once.
- Signal-with-start creates exactly one run under 20 concurrent calls.
- No signal is lost across continue-as-new.
  **Commit:** `feat(core): wait for events and conditions`, `feat(core): signal dedup and signal with start`

#### Day 47: Search attributes, memo and visibility queries

**Goal:** Operators can find runs by business data.
**Scope:**

- Typed search attributes set at start and updated from the workflow, with an upsert event.
- A memo.
- Indexed storage.
- A small filter grammar (`status = 'FAILED' and customerId = 'c-1' and startedAt > '...'`) parsed into parameterized SQL. No string concatenation.
- `GET /v1/runs?query=...`, `wf run list --query`, and search in the UI.
  **Done when:**
- A query over 100,000 runs answers in under 100 ms, with `EXPLAIN` evidence in `docs/BENCHMARKS.md`.
- Malformed and hostile queries are refused with a 400 naming the position.
- Attribute updates survive replay and continue-as-new.
  **Commit:** `feat(core): search attributes and memo`, `feat(api): visibility queries`

#### Day 48: Step heartbeats, step timeouts and typed definitions

**Goal:** Long steps report progress, and workflow code is checked by the compiler.
**Scope:**

- `ctx.heartbeat(details)` inside a step, with a heartbeat timeout.
- The last details are passed to the retried attempt.
- Schedule-to-close and start-to-close timeouts.
- Typed definitions: `defineWorkflow`, `defineStep`, signals, queries and updates carry input and output types, so `ctx.step(chargeCard, input)` is checked at compile time. The string form keeps working.
  **Done when:**
- A step that stops heartbeating is retried after the heartbeat timeout on a fake clock and resumes from its last details.
- A step past its schedule-to-close timeout fails with a typed error.
- A type test (`expectTypeOf`) rejects a wrong input type.
  **Commit:** `feat(core): step heartbeats and timeouts`, `feat(core): typed workflow definitions`

---

### PHASE 11: FLOW CONTROL (Days 49-52)

#### Day 49: Priorities, separate pools and namespace fairness

**Goal:** Urgent work goes first, and one tenant cannot starve the rest.
**Scope:**

- A task priority set at start and inherited by children.
- The dequeue order uses priority, through an index.
- Workflow tasks and step tasks get separate concurrency pools in a worker, so long steps do not block decisions.
- Dequeue round-robins across namespaces.
  **Done when:**
- With 10,000 low-priority tasks queued, a high-priority run completes within one poll interval of a free slot.
- With one namespace holding 10,000 tasks and another 10, the second namespace's tasks finish first.
- Long steps filling the step pool do not delay a workflow decision.
  **Commit:** `feat(core): task priorities and namespace fairness`

#### Day 50: Concurrency keys

**Goal:** Limit concurrent runs or steps per business key, such as one per customer.
**Scope:**

- `concurrency: { key, limit }` on workflows and steps, evaluated from the input.
- Enforced in the database at dequeue time.
- A sleeping or waiting run holds no slot.
- Metrics for queued-by-key.
- A UI hint on runs waiting for a slot.
  **Done when:**
- With limit 1 per key, 50 runs over 5 keys never have two running for one key, checked by the invariant checker.
- A run that sleeps frees its slot.
- A crashed worker's slot is reclaimed with its lease.
  **Commit:** `feat(core): concurrency keys`

#### Day 51: Shared rate limits, debounce and singleton

**Goal:** Protect downstream systems across all processes.
**Scope:**

- Rate limits per queue or per key (`limitPerPeriod`, `period`) enforced in Postgres.
- They replace the per-process limiter of ADR-0033 for quotas too.
- Start options:
  - `debounce` (the last start in a window wins);
  - `singleton` (refuse or queue while one is open);
  - an idempotency key with a TTL.
    **Done when:**
- Three API processes together admit no more than the limit in a window.
- 10 starts in a debounce window produce one run with the last input.
- Singleton under 20 concurrent starts yields exactly one open run.
- An expired idempotency key starts a new run.
  **Commit:** `feat(core): shared rate limits`, `feat(core): debounce and singleton starts`

#### Day 52: Pause and schedule policies

**Goal:** Operators can stop the flow without losing it.
**Scope:**

- Pause and resume for a run, a queue and a namespace. Paused work stays queued and timers still fire into a held state.
- Schedule overlap policies (`skip`, `buffer_one`, `cancel_other`, `allow_all`).
- Schedule backfill for a time range.
- Schedule pause.
- API, CLI and UI for all of it.
  **Done when:**
- A paused queue dequeues nothing and resumes with every task intact.
- Each overlap policy has a test on a fake clock.
- A backfill of 24 hours of an hourly schedule starts 24 runs exactly once, even when it runs twice.
  **Commit:** `feat(core): pause and resume`, `feat(core): schedule overlap and backfill`

---

### PHASE 12: SCALE (Days 53-56)

#### Day 53: Fewer statements per run

**Goal:** Cut the main throughput limit measured on day 28.
**Scope:**

- Fold the hot paths into single statements or SQL functions:
  - start a run;
  - complete a step: record, ack and enqueue the workflow task;
  - complete a workflow task.
- A partial unique index on pending workflow tasks per run, so a fan-out does not produce N replays.
- Batch acks and heartbeats.
- Move the heartbeat to a non-indexed lease column so it can be a HOT update.
- Tune autovacuum per table for `tasks`, `timers` and `run_stickiness`.
  **Done when:**
- Statements per 3-step run drop from about 47 to at most 15, counted by a test with a statement counter.
- Steps per second improve, shown in `docs/BENCHMARKS.md` with before and after medians of 5 runs.
- The chaos suite still shows zero violations.
  **Commit:** `perf(core): fold hot paths into single statements`, `docs: benchmark after statement reduction`

#### Day 54: Wake-ups, leader election and batched timers

**Goal:** Low latency when idle, and no duplicated background work.
**Scope:**

- LISTEN/NOTIFY on enqueue as a wake-up hint, one notification per transaction, on a dedicated connection, behind a flag. Polling stays as the fallback.
- The timer, schedule and janitor loops run on one elected process per queue, through an advisory lock, with fast takeover.
- Timers fire in batches.
- Document PgBouncer transaction mode and the session connection that LISTEN needs in `docs/DEPLOYMENT.md`.
  **Done when:**
- Idle-queue start-to-first-step latency p50 drops below 20 ms (before and after figures).
- With 3 engines, background loops run on exactly one, and a killed leader is replaced within 2 lease periods.
- 10,000 timers due at once fire exactly once.
  **Commit:** `perf(worker): notify wake-ups`, `feat(worker): leader election for background loops`

#### Day 55: Retention and cleanup

**Goal:** No table grows without bound.
**Scope:**

- Finished tasks are deleted on ack, or moved to an append-only history table. Update the invariant checker accordingly.
- Retention jobs, per namespace, for the closed run data:
  - `workflow_task_results`;
  - `step_attempts`;
  - fired timers;
  - `schedule_triggers`;
  - requeued dead letters.
- The history compactor runs on a schedule in the elected process.
- Compaction of long-running open runs past a size threshold, if `docs/REVIEW.md` section 2 still shows it unbounded. Otherwise record why not.
  **Done when:**
- After 10,000 completed runs and the retention period, every listed table is back to the size of the open runs, checked by a test.
- `tasks` size stays flat in a 30 minute benchmark.
- Open runs are untouched.
  **Commit:** `feat(core): retention for closed runs`, `perf(core): delete finished tasks`

#### Day 56: Partitioning, archival and read replicas

**Goal:** History scales by time, and reads leave the primary.
**Scope:**

- Native range partitioning of `run_events` (and closed-run tables as the ADR decides) by time, with a partition maintainer in the elected process.
- Retention becomes detach and drop.
- Archival exports a partition to NDJSON files before it is dropped, and `wf history import` reads them back for replay.
- An optional `DATABASE_READ_URL` serves list, history, UI and metrics reads, with read-your-writes after a start or signal.
- A migration converts an existing database with open runs.
  **Done when:**
- The migration converts a database with 100,000 runs, open and closed, and every open run completes afterwards.
- An archived run replays from its export.
- Reads go to the replica in a test with two databases.
- Benchmarks show no regression.
  **Commit:** `feat(core): partitioned history`, `feat(core): archival and read replica routing`

---

### PHASE 13: OPERATIONS AND RELEASE (Days 57-60)

#### Day 57: Admin surface and key scopes

**Goal:** Everything that is code-only today has an endpoint and a command.
**Scope:**

- An admin API and `wf namespace`, `wf keys` and `wf quota` commands.
- Keys get scopes (`read`, `operate`, `admin`), an expiry and `last_used_at`.
- Issuing a key no longer creates a namespace.
- `wf run terminate`, `wf dlq list|requeue`, and a quarantine endpoint, command and UI view.
- An audit log of admin and operator actions.
  **Done when:**
- A `read` key is refused every write, with a 403.
- An expired key gets a 401.
- Every admin action appears in the audit log with its actor.
- A quarantined task can be listed and released from the UI (Playwright).
  **Commit:** `feat(api): admin endpoints and key scopes`, `feat(cli): admin commands`

#### Day 58: Payload codec and encryption

**Goal:** Sensitive data never reaches the database in clear text.
**Scope:**

- One codec path for every payload: events, `step_results`, `tasks.payload`, and the run input and result.
- An encryption codec (AES-256-GCM through `node:crypto`) with key ids and key rotation.
- A codec endpoint that the UI and CLI call to decode, so the server can store only ciphertext.
- Search attributes stay clear text by design.
- Fix the gzip codec so it can be stored with the Postgres store.
- Masking is applied in logs and the UI.
  **Done when:**
- With encryption on, no plaintext payload appears in any table, checked by a test that scans every row.
- Rotating the key keeps old runs readable.
- The UI shows decoded payloads only through the codec endpoint.
- The gzip codec round-trips through Postgres.
  **Commit:** `feat(core): unified payload codec and encryption`

#### Day 59: Reset, fork and batch operations

**Goal:** Recovering from a bug in production is a command, not a script.
**Scope:**

- `reset` of a run to a chosen event: a new run whose history is copied up to that point, linked to the old one.
- `fork` with new code from step N.
- Batch cancel, terminate, signal, reset and requeue, driven by a visibility query (day 47).
- Batches are executed as a workflow, so they are durable, resumable and rate limited.
- API, CLI and UI.
  **Done when:**
- A run that failed on a bug is reset after a code fix and completes, with steps before the reset point not executed again.
- A batch terminate over 1,000 runs survives a worker kill midway and touches each run exactly once.
  **Commit:** `feat(core): reset and fork`, `feat(core): batch operations`

#### Day 60: v0.2.0

**Goal:** A release that a team can adopt.
**Scope:**

- Re-run the benchmarks and the chaos suite and update their documents.
- An upgrade guide from 0.1 to 0.2 that covers open runs across the migrations, proven by a test that upgrades a database of v0.1.1 with open runs.
- Update:
  - `README.md`;
  - `docs/ARCHITECTURE.md` and `docs/CONCEPTS.md`;
  - `docs/ROADMAP.md`: what was deferred, plus streamed step output, worker deployment versioning, a step-only worker SDK over HTTP, interceptors and keyed entities as the next candidates;
  - `CHANGELOG.md`.
- Release `v0.2.0` through the day 42 pipeline.
  **Done when:**
- The upgrade test passes.
- Every CI job is green on the release commit.
- The release workflow ran for `v0.2.0`.
- The README quick start works from the published artifacts, or from the packed ones if the owner has not yet enabled publishing (recorded in `STATE.md`).
  **Commit:** `docs: v0.2 documentation`, `chore(release): v0.2.0`

---

## SECTION C: SPARE TASK POOL

If the day finishes early, take from here in order, do not touch the next day's scope.

1. Measure the test coverage of the current module, write tests for the file with the lowest coverage.
2. Add a property-based test (fast-check) for an existing invariant.
3. Fill in the missing TSDoc comments on the public API.
4. Add an explanation of the mechanism you wrote today into `docs/CONCEPTS.md`.
5. Make an error message more diagnosable (context, likely cause, suggested fix).
6. Shorten the CI time (cache, parallel jobs).
7. Write today's implicit decisions into `docs/DECISIONS.md` as ADRs.

## SECTION D: HIGH-RISK DAYS

Days 5, 6, 12, 19, 21, 27, 32, 33, 34, 43, 53 and 56 carry the highest risk of overrun. If the scope has to be split on these days, preserve the core behavior and defer the ergonomics and the extra tests to `docs/DEFERRED.md`. Never give up the determinism, crash recovery and idempotency guarantees.
