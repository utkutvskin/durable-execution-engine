# Changelog

All notable changes are listed here. The format follows Keep a Changelog and the project follows semantic versioning.

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

[0.1.0]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.1.0
