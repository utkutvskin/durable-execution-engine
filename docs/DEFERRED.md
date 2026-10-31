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

## `npx wf dev` on a machine without a checkout (day 29)

`wf` runs the TypeScript sources of this repository through Node's type stripping and the workspace links, so `npx wf dev` works after `pnpm install` in a checkout, not from a published package. There is no `dist` build or published package yet. To close this: bundle the cli and its workspace dependencies into a publishable package, or compile the packages and publish them (day 30 covers the release).

## Examples against a real provider and warehouse (day 29)

The payment gateway and the warehouse of the examples are in memory, so the demos prove the workflows, the compensation, the retries and the idempotence of the steps, not an integration. Nothing deploys the examples as a separate worker process; `wf worker --module examples/payment-saga/src/index.ts` is the way to run one. To close this: add a gateway implementation over a real sandbox API and a warehouse over a second Postgres schema, and run the demos against them.

## The image was not built and is not published (day 30)

The Dockerfile and the compose `engine` profile were written in a session without a Docker daemon. The build steps were reproduced outside Docker (see ADR-0040), but `docker build` has not run, and the image is not pushed anywhere. The `docker` job in CI builds it and runs a smoke test against a Postgres service. To close this: read the first CI result of that job, then add a tag triggered workflow that pushes the image to a registry.

## The release object (day 30)

`CHANGELOG.md` holds the release note. The annotated tag `v0.1.0` is on `origin`, on commit `67c63c9` (`chore(repo): license under apache-2.0`, ADR-0041); the owner pushed it, because the session git proxy rejects tag pushes from agent sessions. A GitHub release object is not created yet, and the session tools cannot create one. To close this: in GitHub, draft a release from the `v0.1.0` tag and paste the `0.1.0` section of `CHANGELOG.md`.

## Production entry points of the cli (day 30)

`wf dev` is the only process that serves the API, and it does not switch on tracing, quotas or the history compactor; `wf worker` takes `--queue` and `--concurrency` but not pool size. There is no admin command for namespaces, keys and quotas. To close this: see "Next" in `docs/ROADMAP.md`.

## The quick start was verified on a checkout, not in a clean container (day 30)

The steps of the README were run from a fresh `git clone` of the pushed commit in an empty directory with a fresh `pnpm install` against the local Postgres, and the same flow is covered by the test of the `hello` example. They were not run in a container image of a clean machine, because no Docker daemon was available. To close this: run the README steps in a `node:22` container with a Postgres service.

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

