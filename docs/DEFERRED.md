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

## Step tasks are enqueued outside the decision's transaction (day 29)

The engine records a workflow decision and then enqueues the `STEP_TASK` of each scheduled step in a second transaction. A crash in between delays the step by the stalled run grace period (60 seconds by default) until the janitor sends a workflow task, which recreates the missing step task. No work is lost and no step runs twice because of it, but the delay is visible. To close this: have the recorder enqueue the `STEP_TASK` of a `step_scheduled` event in the same transaction as the event.

## The image was not built and is not published (day 30)

The Dockerfile and the compose `engine` profile were written in a session without a Docker daemon. The build steps were reproduced outside Docker (see ADR-0040), but `docker build` has not run, and the image is not pushed anywhere. The `docker` job in CI builds it and runs a smoke test against a Postgres service. To close this: read the first CI result of that job, then add a tag triggered workflow that pushes the image to a registry.

## The release tag and release object (day 30)

`CHANGELOG.md` holds the release note. The release now includes the Apache-2.0 licence (ADR-0041), so `v0.1.0` belongs on commit `67c63c9` (`chore(repo): license under apache-2.0`), not on the day 30 closing commit. The agent sessions cannot publish it: the session git proxy rejects tag pushes (day 30: `unexpected disconnect while reading sideband packet`; again after the review: `the remote end hung up unexpectedly`, five attempts, while branch pushes succeeded), and their GitHub tools cannot create tags or releases. To close this: from a machine that can push tags, run `git fetch origin && git tag -a v0.1.0 67c63c9 -m v0.1.0 && git push origin v0.1.0`, then create the release in GitHub from that tag and paste the `0.1.0` section of `CHANGELOG.md`.

## Production entry points of the cli (day 30)

`wf dev` is the only process that serves the API, and it does not switch on tracing, quotas or the history compactor; `wf worker` takes `--queue` and `--concurrency` but not pool size. There is no admin command for namespaces, keys and quotas. To close this: see "Next" in `docs/ROADMAP.md`.

## The quick start was verified on a checkout, not in a clean container (day 30)

The steps of the README were run from a fresh `git clone` of the pushed commit in an empty directory with a fresh `pnpm install` against the local Postgres, and the same flow is covered by the test of the `hello` example. They were not run in a container image of a clean machine, because no Docker daemon was available. To close this: run the README steps in a `node:22` container with a Postgres service.
