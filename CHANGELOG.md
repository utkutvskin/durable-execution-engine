# Changelog

All notable changes are listed here. The format follows Keep a Changelog and the project follows semantic versioning.

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

[0.1.1]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.1.1
[0.1.0]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.1.0
