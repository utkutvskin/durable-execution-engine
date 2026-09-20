# Durable Execution Engine: Development Backlog

This file lives at `docs/BACKLOG.md`. Each session reads this file, then `STATE.md`, does only that day's scope, then commits and pushes.

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
5. Make the commits, push to `main`. No `day-NN` tag: this repository does not use daily tags, `STATE.md`'s `Completed day` field and the commit history are the record of progress. This does not apply to the `v0.1.0` release tag on day 30.

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

## SECTION B: THE 30-DAY BACKLOG

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

Days 5, 6, 12, 19, 21 and 27 carry the highest risk of overrun. If the scope has to be split on these days, preserve the core behavior and defer the ergonomics and the extra tests to `docs/DEFERRED.md`. Never give up the determinism, crash recovery and idempotency guarantees.
