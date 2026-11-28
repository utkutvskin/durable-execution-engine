# Changelog

All notable changes are listed here. The format follows Keep a Changelog and the project follows semantic versioning.

## [0.2.0] - 2026-11-28

A release that a team can adopt: published packages and an image, a richer authoring API, flow control, a schema that scales past one table per kind of row, and the operations surface around it. It adds 19 migrations and old and new processes cannot run side by side: follow `docs/UPGRADING.md`, which a test proves on a database left by v0.1.1 with open runs.

### Added

- Distribution: every package is built to JavaScript and packed, a tag runs a release pipeline that publishes `@dee/*` to npm with provenance and pushes a multi-architecture image with an SBOM to GHCR, and the release note is cut from this file.
- Embedded mode: `startWorkflow`, `signalWorkflow` and `cancelWorkflow` write on the caller's own transaction, the `start_workflow` SQL function starts a run from a trigger, and the engine tables can live in their own schema.
- A stability policy, history events with a format version, `wf history export` and `wf replay`, which replays exported histories against new code without a database.
- Workflow updates with a validator and a result, and queries over HTTP.
- Events addressed by a correlation key, buffered until a run waits for them, triggers that start a run on an event, conditions, signal deduplication ids and signal-with-start.
- Search attributes, a memo and visibility queries over runs, in the API, the CLI and the UI.
- Step heartbeats with details, start-to-close, schedule-to-close and heartbeat timeouts, and typed definitions for steps, children, signals and queries.
- Run priorities, separate pools for decisions and steps, and fair turns between namespaces.
- Concurrency keys that limit the open runs or running steps per business key.
- Rate limits shared by every process through Postgres, debounced and singleton starts, and idempotency keys with a TTL.
- Pause and resume of a run, a queue or a namespace, schedule overlap policies including cancel-other, and repeatable backfills.
- Retention of closed runs per namespace, finished tasks moved to `task_history`, and `run_events` partitioned by day, archived to NDJSON and dropped once its runs are purged. `wf history import` turns an archive back into replayable exports.
- Reads from a read replica, with read-your-writes for the process that wrote.
- An admin API and the `wf namespace`, `wf keys`, `wf quota` and `wf audit` commands. Keys have a scope (`read`, `operate`, `admin`), an expiry and a last use, and admin and operator actions are written to an audit log.
- `wf run terminate`, `wf dlq list|requeue` and quarantined tasks in the API, the CLI and the UI.
- A payload codec for every user payload, AES-256-GCM encryption with key ids and rotation, a gzip codec that works with the Postgres store, a codec endpoint that the UI and CLI decode through, and masking in logs and the UI.
- Reset of a run to a chosen event, fork onto new code from step N, and batch cancel, terminate, signal, reset and requeue driven by a visibility query, run as a durable workflow.

### Changed

- The hot paths are SQL functions and a run has one pending workflow task, so a three-step run takes fewer statements. On the benchmark machine v0.2.0 completes 37 percent more steps per second than v0.1.1 and a run's p95 end-to-end latency is 39 percent lower (`docs/BENCHMARKS.md`).
- The background loops run on one elected process at a time, timers fire in batches, and workers can be woken by notifications instead of polling.
- `startEngine` runs a decision pool and a step pool, so with the defaults it runs up to four decisions and four steps at once.
- Every existing api key becomes an `admin` key. Issuing a key no longer creates its namespace.

### Known limitations

- The publishing steps of the release pipeline need the owner's one-time npm and GHCR steps (`docs/RELEASING.md`), and the tags of the releases are pushed by the owner.
- `docs/DEFERRED.md` lists the edges each feature leaves open.

## [0.1.1] - 2026-11-08

A patch release with the fixes from the review of 0.1.0. No migration is skipped: run `wf migrate up` before starting the new processes.

### Fixed

- Replay is deterministic: `now`, `random` and `uuid` come from the history, events replay in order, and every command is matched. Cancelled runs no longer count commands they skip.
- A step records one terminal result. A slow attempt that ends after a retry changes nothing, and the step task is created in the transaction of its decision.
- Poison tasks back off and are quarantined instead of looping, and idle runs waiting on a signal are no longer recovered by the janitor.
- Tasks, timers, signals and recovery follow the queue of their run. Lease and visibility time come from the database clock. A step that loses its lease is aborted.
- A step that uses all its attempts fails for its workflow, which can catch it and compensate. Runs and child runs can have timeouts.
- The API bounds event streams, throttles failed authentication, pages history and dead letters, and logs failures. The UI timeline no longer shows duplicates. The CLI encodes run ids and honours `Retry-After`.
- Migrations take a Postgres advisory lock, so replicas can start together.
- A failed attempt is no longer recorded after the step has its result or the run has closed, which left an invalid history.
- A lost connection while recording a step result or acknowledging its task no longer counts as a failed attempt of the step.

### Added

- `wf serve` and `wf worker` as separate production processes, with the compose services `migrate`, `api` and `worker`.
- Sticky routing by default, so a worker keeps deciding the runs it has cached.
- Task latency and reclaimed lease metrics from the engine.
- A chaos suite that drives the engine runtime: eleven scenarios, ten seeded repetitions each, run nightly with thirty.

### Known limitations

- Nothing is published yet. The container image is built by CI but not pushed.
- A sticky claim lasts 60 seconds, so a dead worker holds its runs that long.

## [0.1.0] - 2026-10-21

First release: a durable workflow engine for TypeScript that needs nothing but Postgres.

### Added

- Workflows and steps written in TypeScript. A workflow is replayed from its history after a crash, and the engine stops a run whose code no longer matches what was recorded.
- Step retries with backoff, and a dead letter queue for steps that run out of attempts.
- Crash recovery: when a worker dies, another one picks up its tasks.
- Durable sleeps and cron schedules.
- Signals, queries, cancellation with compensation, and child workflows.
- Continue-as-new for long-running workflows, and `ctx.patched` for changing code under running ones.
- An HTTP API with API keys, namespaces and quotas.
- A web UI for browsing runs, sending signals and requeueing failed steps.
- Prometheus metrics, JSON logs and OpenTelemetry tracing.
- The `wf` CLI. `wf dev` starts everything locally with one command.
- Three examples: hello world, a payment saga and an ETL pipeline.
- A Dockerfile and a compose setup.
- Apache 2.0 licence.

### Known limitations

- Nothing is published yet. Run it from a clone, or build the image yourself.
- `wf dev` is the only command that serves the API, and it doesn't turn on tracing or quotas.
- A review after the release found bugs in replay and in the task queue. They are listed in `docs/REVIEW.md` and will be fixed in 0.1.1.

[0.2.0]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.2.0
[0.1.1]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.1.1
[0.1.0]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.1.0
