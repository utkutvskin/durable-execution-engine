# Deferred

Work that a day's scope named and that could not be finished or proven in its session. Each entry says what is missing and why.

## Jaeger check of the span tree (day 24)

The "Done when" item for day 24 asks for a run with a child workflow to appear in Jaeger as one unbroken span tree. The compose file now starts Jaeger (`docker compose up -d jaeger`), but the session that built the day had no Docker daemon, so the tree was verified against an in-memory exporter instead: one trace id, one root, every parent present, in `packages/core/src/observability/run-tracing.test.ts`. The OTLP exporter and the Jaeger UI were not exercised. To close this: run a traced parent and child workflow with `createTracingProvider({ otlpEndpoint })` against the compose Jaeger and confirm the tree in the UI.

## Chaos faults that need control of the server (day 27)

The chaos suite injects every fault in front of Postgres (see ADR-0037). Not covered: restarting the Postgres server under load, a real fsync stall or a full disk, and packet loss between hosts. To close this: run the same scenarios against a Postgres in compose and restart or throttle that container from the harness.

## Broken connections returned to the pool (day 27)

Code that takes a client with `pool.connect()` releases it with `client.release()`. When the connection died while the client was held, the client goes back into the pool and the next statement on it fails once before pg drops it. The engine survives this because a failed task is redelivered, but a statement fails that did not need to. To close this: release with `client.release(error)` in the catch paths of the recorder, the timer scheduler, the schedule manager and the projection store, or evict a client in `createPool` when it reports an error.

## Benchmarks on more than one machine (day 28)

`docs/BENCHMARKS.md` is measured with the benchmark process and Postgres on one 4 core machine with default settings. Not measured: workers on separate hosts, a remote database, a tuned Postgres (`shared_buffers`, `synchronous_commit`), and runs that execute through the workflow decision loop (the benchmark drives the recorder directly, as the chaos suite does). The statements per run (about 47) are the main lever left; see the "What to try next" list in that file. To close this: run `pnpm run bench` against a Postgres in compose from a second machine and add the figures next to the local ones.

## The packages are not on npm yet (day 41)

Every package builds to `dist` and the packed tarballs install into an empty directory and run `npx wf dev` (the `packages` job of `ci.yml`), so the old limit of running only from a checkout is gone. They are not published to a registry yet. The release pipeline exists since day 42 (`docs/RELEASING.md`) but needs the owner's one-time npm and GHCR steps. To close this: do those steps, push a release tag and install from the registry instead of from tarballs.

## Examples against a real provider and warehouse (day 29)

The payment gateway and the warehouse of the examples are in memory, so the demos prove the workflows, the compensation, the retries and the idempotence of the steps, not an integration. Nothing deploys the examples as a separate worker process; `wf worker --module examples/payment-saga/src/index.ts` is the way to run one. To close this: add a gateway implementation over a real sandbox API and a warehouse over a second Postgres schema, and run the demos against them.

## The image was not built and is not published (day 30)

The Dockerfile and the compose `engine` profile were written in a session without a Docker daemon. The build steps were reproduced outside Docker (see ADR-0040), but `docker build` has not run, and the image is not pushed anywhere. The `docker` job in CI builds it and, since day 39, runs the split services (two migrations together, an `api` container, two `worker` containers, the payment saga, a metrics check and the compose services); the day 39 session had a `docker compose config` check but no daemon either, so the first CI result of that job is the first time those steps run. The tag triggered workflow that pushes the image exists since day 42 (`docs/RELEASING.md`); its push step has not run. To close this: do the GHCR steps in that file and push a release tag.

## The release object (day 30)

`CHANGELOG.md` holds the release note. The annotated tag `v0.1.0` is on `origin`, on commit `67c63c9` (`chore(repo): license under apache-2.0`, ADR-0041); the owner pushed it, because the session git proxy rejects tag pushes from agent sessions. A GitHub release object is not created yet, and the session tools cannot create one. To close this: in GitHub, draft a release from the `v0.1.0` tag and paste the `0.1.0` section of `CHANGELOG.md`.

## Production entry points of the cli (day 30, mostly closed on day 39)

`wf serve` runs the API alone and `wf serve` and `wf worker` take pool size, log level and format, a tracing endpoint, quotas (serve), the compactor schedule and a health port (worker). What is still missing is an admin command for namespaces, keys and quotas: `wf serve` can register one key from `WF_API_KEY` and set the quotas of its namespace, nothing lists, rotates or revokes keys. To close this: see "Next" in `docs/ROADMAP.md`.

## Real-time pacing in polling test loops (day 31)

The `setTimeout(resolve, 10)` and `setTimeout(resolve, 25)` calls that remain in `packages/worker/src/engine/engine.integration.test.ts`, `examples/etl-pipeline/src/etl-pipeline.integration.test.ts`, `examples/payment-saga/src/payment-saga.integration.test.ts` and `packages/cli/src/cli.integration.test.ts` are not waits for a clock: each one yields between two polls of a run that a real engine loop is advancing, while the test moves a shiftable fake clock. They bound how fast the test polls, not how long it waits, and the loops end on the run status. To close this: give the engine a manual tick (`runOnce`) so the tests drive the loops instead of polling, then delete the yields. The other `setTimeout` matches in tests are fakes or assertions about the sandbox and are not waits. `examples/hello` no longer waits on real time: it polls the run history for `timer_started`.

## Limits of the sandbox and of the recorded context values (day 32)

- The sandbox refuses the globals by looking them up at call time. Code that saved a reference before a decision (`const now = Date.now` at module load, `import { randomUUID } from "node:crypto"`, a library that captured `setTimeout`) reaches the real function unnoticed. `ctx.now()`, `ctx.random()` and `ctx.uuid()` are the only supported sources.
- The check for workflow code that is still active after quiescence follows the async resources (timers, file and network requests) created inside the decision's call chain. It does not see a non-`ctx` promise that is already settled and will only resume later through another decision's context, nor work done by a native callback that does not propagate async context.
- Every `ctx.now()` call adds a `time_recorded` event, so code that reads the time in a loop lengthens its history. A cheaper form (one marker per decision) is possible but would tie the answer of a call to the decision it was first reached in.
- `ctx.random()` and `ctx.uuid()` depend on the order of value calls in the workflow (ADR-0042); a code change that reorders them changes later values and is not detected, because nothing about them is recorded.

## Command matching limits (day 33)

Cancellation is still read from the whole history: once a `cancel_requested` event exists, a wait for a command the history does not hold rejects at the call, not at the position of the cancel event. A cancel that arrived between two commands is therefore replayed as if it came first. The property test generates steps, sleeps, signals and signal-reacting branches, not `ctx.select`, `ctx.all`, children, patches or cancellation, which the live session does not resume; the cold replay of those is covered by the existing decision tests only.

## Step tasks of a lost step are healed only by a workflow task (day 34)

The recorder creates the `STEP_TASK` of a `step_scheduled` event in the same transaction as the event, so a crash no longer delays a step. If a step task row is lost by other means (an operator deleting it, a manual prune), only the next workflow task of the run recreates it, through the check on a suspended decision, and a run waiting only on that step gets such a task from the janitor after the stalled run grace. The recorder also creates no task when it is built without a `queueName`; the chaos harness and the benchmark build it that way and enqueue themselves. To close this: give the janitor a check for open steps without a task.

## Read-only database paths still return clients after any error (day 34)

`withClient` and `withTransaction` destroy a client only when its rollback also fails. The read-only paths that do not open a transaction (the invariant checker, the projection read) destroy the client on any error, which is safe but discards healthy connections after an ordinary SQL error. To close this: classify the error by its code and destroy the client only for connection errors.

## Parked tasks and waiting runs have no operator surface (day 35)

A task parked for a code or deployment error (`NonDeterminismError`, `VersionMismatchError`, an unknown workflow type) and a run marked `waiting_on` can be read only through `Janitor.listQuarantined` and the `workflow_runs` column. The API, the CLI and the UI do not list or release them, and no metric counts parked tasks by reason. A lost enqueue on a path that ends a wait (a signal, a child result) is no longer healed by the janitor for a marked run. To close this: an API route and CLI command for quarantined tasks, and a slow safety sweep of waiting runs.

## Queue routing, database time and abort limits (day 36)

- Moving a run between queues has no API; `workflow_runs.queue_name` is updated by hand and open tasks keep the old queue. `wf` and the API serve one queue per process, so a two-pool setup needs two API processes or a queue argument on the start route.
- The "two engines on different queues" proof is at component level (timer, signal, cancel, close, janitor and schedule manager against one database), not two `startEngine` instances over a long run.
- Timers and schedules still read the host or injected clock for their due check; only the task queue and the janitor use database time. A fast host can fire a timer or a trigger early by its skew.
- Catch-up instants skipped by `latest_only` or by the window are not recorded in `schedule_triggers`, so nothing shows how many were dropped. Finding the latest instant steps through every missed minute, which is slow for a schedule that was off for years.
- A step that ignores its abort signal keeps running after its lease is lost; the engine stops waiting for it, but only the step's own code can stop its side effects.
- `ERRORED` schedules have no API, CLI or UI surface yet.

## Timeouts, requeue and compacted queries (day 37)

- Timeouts are set per run at creation (API start, child options). A workflow definition cannot declare a default, and schedules cannot set them, so a scheduled run is unbounded.
- A requeued dead letter is acknowledged without running the step, so the dead letter queue is now an inspection list, not a retry path. A resume flow (run the step again and let a waiting workflow continue) would need a new event kind and a design for workflows that already moved on.
- `queryRun` on a compacted run rejects with `RunHistoryCompactedError`; answering it would need the query handler state kept in the snapshot or the history kept for replay.
- `compensation_failed` is not shown in the web UI timeline as a special row, and the live session treats the new event kinds as unsupported, which makes a run that cancels replay from the top once.
- The step `details` are the own enumerable JSON-serializable properties; values that do not serialize (functions, bigint, cycles) are dropped silently.

## API, UI and CLI hardening (day 38)

- API keys still have no expiry, no `last_used_at`, no scopes and no admin endpoint, and `issue` still creates a namespace silently (`docs/REVIEW.md` section 4, item 8). Only the items of the day's scope were done.
- The throttle counts failures per socket address, so clients behind one proxy or NAT share a budget, and a valid key from a throttled address is refused until the window ends. Reading `x-forwarded-for` needs a trusted proxy setting that does not exist. The counters live in process memory, so the budget is per API process.
- `metricsCacheMs` defaults to 0 and `maxStreamsPerNamespace`, `maxStreamLifetimeMs` and the throttle are options of `createApiHandler`; no bundled process sets metrics caching or a metrics token yet (the entry points are day 39).
- A run stream reads each slice whole: a history of hundreds of thousands of events arrives in one `slice` event. The page limit applies to `/history` only.
- `dee_task_latency_seconds` and `dee_leases_reclaimed_total` are still not filled by a bundled process, and `/metrics` still runs its aggregates on every uncached scrape.
- `maskSensitiveFields` stays unwired; the documentation now says so. Masking in the UI and the API would change what operators can debug.
- The UI cancel and requeue confirmations use the browser `confirm` dialog, which a page cannot style and a test must answer.
- `wf worker` can still spawn `docker compose` in production, and `migrateUp` still takes no lock (review items 1 and 2; day 39).

## Metrics of a worker are scraped one by one (day 39)

`dee_task_latency_seconds` and `dee_leases_reclaimed_total` live in the memory of the process that observed them, so the API process shows neither and a fleet needs every worker scraped and summed. A shared place for them (a table the workers flush into, or a push gateway) would make one scrape complete. The API's failed authentication throttle and rate limit are also per process (ADR-0048, ADR-0033).

## Sticky claims cost a write per decision (day 39)

A worker refreshes its claim on a run after every decision that leaves the run open (`run_stickiness` upsert) and deletes it when the run closes. That is one statement per workflow task. The claim is not checked against the cache: a worker whose cache evicted the run still holds the claim until it expires (60 seconds by default) and the other workers wait for it. Releasing the claim on eviction, and measuring the write against the replay it saves, are open.

## The v0.1.1 tag (day 40)

The session could not push the annotated tag `v0.1.1`, so it is not on `origin`. `CHANGELOG.md` holds the release note. To publish it, from a clone of the repository with the commit of `chore(release): v0.1.1` checked out on `main`:

```sh
git checkout main && git pull --ff-only
git tag -a v0.1.1 -m "v0.1.1" "$(git log --format=%H --grep='^chore(release): v0.1.1' -n 1)"
git push origin v0.1.1
```

The commit hash is also written in `STATE.md`, day 40.

## Chaos limits (day 40)

The engine scenarios inject faults through checkpoints of the step handler, moved clocks, proxies and a frozen process; they do not kill a process at an arbitrary instruction. The workloads use one step, one sleep or one signal wait, so child workflows, continue-as-new and compaction are not under chaos. A run that carries the waiting marker is never reported as stalled, so the checker cannot tell a signal that never arrives from one that is late. The nightly workflow is in `.github/workflows/chaos-nightly.yml`; its first scheduled run happens on `main` after the push, and a manual run can be started with `workflow_dispatch`.

## The publishing steps of the release pipeline have not run for real (day 42)

The workflow `release.yml` rehearses everything except `npm publish` and the GHCR push in a dry run. The two publishing steps need the owner's npm scope, the trusted publishers and the GHCR visibility (`docs/RELEASING.md`); until then they are unproven, as are the exact options of `npm publish --provenance` under trusted publishing and the arm64 build under QEMU. To close this: do the one-time steps and push a pre-release tag, then a release tag.

## Catching up a long-paused schedule walks every missed minute (day 42)

A schedule with `* * * * *` whose `next_fire_at` lies months in the past is caught up by stepping through the cron times one by one, so the first tick after a long pause costs time proportional to the pause (about 22 seconds for 270 days on a laptop). It surfaced as a test that pinned its start date and slowly crossed the 30 second test timeout; the test now starts one hour ago. To close this: jump straight to the last due time for the `latest_only` policy instead of iterating.

## Embedded mode leaves a few surfaces out (day 43)

`startWorkflow`, `signalWorkflow` and `cancelWorkflow` take a `pg` `PoolClient`; a `pg.Client` or a connection of another driver (Drizzle, Knex, Prisma) needs a small adapter that is not written. The CLI has no `--schema` flag or `WF_SCHEMA` variable: `wf worker`, `wf serve` and `wf migrate` follow the `search_path` of `DATABASE_URL`. The SQL function `start_workflow` cannot set run or execution timeouts and always writes plain JSON, so it cannot be used with a compressing codec. There is no SQL counterpart for signal and cancel. To close this: an adapter type over `query`, a `--schema` flag on the three commands, and timeout parameters on the function.

## Types the entry points use but do not export (day 44)

The API reports in `api-reports/` carry `ae-forgotten-export` warnings: public signatures of `@dee/core` refer to `RunTimeoutLimits`, `TaskLease`, `StepTaskContext`, `stepTaskPayloadSchema` and five command types, and `@dee/cli`'s `CliHooks` to `ProcessHooks`, `HistoryHooks` and `DatabaseHooks`, none of which are exported. A user can use the values but cannot name their types. To close this: export them (or narrow the signatures), run `pnpm run api:update` and commit the reports.

## OpenAPI responses are not compared with a committed document (day 44)

`docs/STABILITY.md` promises the `/v1` request and response shapes. The OpenAPI document is generated from the route schemas and checked to be valid, but nothing compares it with a committed copy, so a changed response field passes CI. To close this: commit the generated `/openapi.json` next to the API reports and fail CI when it changes without an update, the way `pnpm run api:check` does for exports.

## A history export reads every page through the API (day 44)

`wf history export` uses the API, so it needs a running `wf serve` and a key, and a compacted run cannot be exported at all. To close this: add a `--database-url` mode that reads `run_events` directly, and decide whether an export of a compacted run should carry its snapshot.

## Updates leave a few edges open (day 45)

The validator runs once, on the API side, against the state the run is in; it is not run again inside the workflow, so a handler cannot assume anything the validator did not check at that point. An update whose handler still waits (for a step, say) when the run completes, fails or continues as new never records `update_completed`, and its caller gets `accepted`; continue-as-new does not carry it over. The wait for the outcome polls the history every 50 ms instead of using `LISTEN`/`NOTIFY`. The live session of the sticky decider does not resume update handlers, so such a workflow is replayed in full on every decision. To close these: decide whether a handler still running at close should fail its update with a typed error, move the wait onto a notification channel, and teach the live session to deliver `update_accepted`.

## Events, triggers and conditions leave a few edges open (day 46)

Buffered events in `external_events` are never deleted; they only stop matching once `expires_at` passes, and `event_waits` rows stay after their run closes. Event triggers can be created and listed but not removed or paused, and there is no CLI command for events, triggers or signal-with-start. `signalWithStart` has no embedded (`PoolClient`) form in `@dee/core`'s transactional API, and it answers `RunNotOpenError` for a key whose chain closed instead of starting a new run. `ctx.condition` cannot be a branch of `ctx.select`, and the live session of the sticky decider falls back to a full replay for `waitForEvent` and `condition`. Events of the same name and key are not ordered by a sender sequence, only by `received_at`. To close these: a janitor sweep for expired events and closed waits, `DELETE /v1/event-triggers/{id}` (the router only knows GET and POST today), `wf event send` and `wf run signal-with-start`, an embedded `signalWithStart`, and live-session support.

## Search attributes and visibility leave a few edges open (day 47)

An ordering on a search attribute (`amount > 10`) is evaluated row by row while the namespace or status index is walked, so a selective range with no other filter reads many runs (51,000 for one match in 1,000 over 100,000 runs, 33 ms) and a range that matches nothing reads all of them. A time held in a string attribute compares as text, which is only right for UTC ISO-8601 values. The memo is set at start and carried by continue-as-new, but a workflow cannot change it. `wf run start` takes no `--search-attributes` or `--memo`, the SQL function `start_workflow` takes neither, and a run started before migration 0024 has none. The grammar has no `in`, `is null`, `like` or ordering clause, and the live session of the sticky decider falls back to a full replay for a workflow that upserts. To close these: declared attribute types per namespace with an expression index per numeric or time attribute, `ctx.upsertMemo`, the cli flags and a `start_workflow` overload, `in (...)` and `exists(name)`, and live-session support.

## Heartbeats, step timeouts and typed definitions leave a few edges open (day 48)

A heartbeat does not renew the task's lease, so a step that heartbeats past its visibility timeout is still redelivered to another worker; heartbeats are coalesced but not throttled by time, so a tight loop of heartbeats writes as fast as the database answers; and a heartbeat write that fails is dropped without a log line. The heartbeat timeout is enforced by the worker running the attempt, so a dead worker is still noticed only by lease expiry. A task enqueued before day 48 has no `scheduledAt` and no schedule-to-close deadline. The history and the UI do not show heartbeats. Typed definitions cover the workflow side only: `signalRun`, `queryRun`, `updateRun`, the embedded `signalWorkflow` and `startWorkflow` and the HTTP client still take names and `unknown` payloads, and `ctx.waitForEvent` has no event definition. To close these: renew the lease from a heartbeat, throttle heartbeat writes by an interval, log dropped writes, show the last heartbeat on the run page, and add typed overloads to the client functions and a `defineEvent`.

## Priorities and fairness leave a few edges open (day 49)

A run's priority is fixed at start: there is no way to raise it while it runs, a child run always inherits its parent's (`ctx.startChild` has no `priority` option), `wf run start` has no `--priority` flag, and the `start_workflow` SQL function takes none. The run list and the run page do not show the priority. Priority is strict, so a steady stream of urgent work starves the rest; there is no aging. Fairness is per namespace within a queue and does not weigh namespaces, and an empty poll probes every namespace, so a database with thousands of namespaces pays for each. To close these: a `PATCH /v1/runs/{id}` priority change that also updates the open tasks, a child option, the cli flag and a `start_workflow` overload, priority in the run description, weighted turns per namespace, and a lane list limited to namespaces that have open tasks.

## Concurrency keys leave a few edges open (day 50)

A key is evaluated by the worker, so a keyed run's first task is leased once without a slot only to record the key, and a run started before its workflow had a rule gets its key at its next task. A key function that throws fails the task like any handler error. The run slot follows open tasks, not leases: a run whose step waits out a retry backoff keeps its slot, and a run whose step task waits for a step slot can hold a run slot meanwhile. A dead-lettered step acks its task before the follow-up workflow task is written, so for that moment another run of the key can take the slot. Within a pool every waiter is held to its own limit, so two definitions sharing a key text with different limits get different answers. A dequeue scans past blocked keyed tasks on every poll, and a batch that holds several tasks of a full key leases fewer than `limit`. `concurrency_slot_history` is never pruned. `readRunConcurrency` judges due tasks by the database's time. The UI hint is read with the run description, so it does not change until the run page refreshes, and the run list does not show it. To close these: evaluate keys where the run starts when the starter has the definition, enqueue the dead-letter follow-up in the dead letter's transaction, a per-key wait index, history retention with the run, and the hint in the run list.

## Rate limits and start policies leave a few edges open (day 51)

A step task refused by a rate limit is leased once to learn that, and a step with both a key limit and the queue limit spends the key's admission even when the queue limit then refuses it, so the pair admits less than either limit allows. A rate limited task holds its run's concurrency slot while it waits. The limiter trusts the callers' clocks: processes whose clocks disagree see slightly different windows. Debounce and singleton are API options only: the embedded `startWorkflow`, the `start_workflow` SQL function, child workflows, schedules, event triggers, `wf run start` and the UI do not take them, and continue-as-new does not carry the singleton key, so the next run of a chain is not counted as the key's open run. A pending start fires only while an engine's schedule loop runs, at most one interval late, and there is no endpoint to list or cancel pending starts. An expired idempotency key is freed by the next start with that key, not by a sweep. To close these: check rate limits in the dequeue statement, evaluate the queue limit first, a per-run start policy for the other start paths, the singleton key on `run_continued_as_new`, and `GET`/`DELETE /v1/pending-starts`.
