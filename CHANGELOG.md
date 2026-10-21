# Changelog

All notable changes are listed here. The format follows Keep a Changelog and the project follows semantic versioning.

## [0.1.0] - 2026-10-21

The first release. Everything below is new.

### Added

- Event store: an append-only history per run with optimistic concurrency, a projection folded from the events, and a codec layer with size limits, compression and masking of sensitive fields.
- Workflow DSL: `defineWorkflow`, `defineStep` and the `ctx` API (`step`, `sleep`, `now`, `random`, `uuid`) with deterministic replay, non-determinism detection and a sandbox for forbidden globals.
- Task queue with leases, heartbeats, redelivery, graceful shutdown and a worker poll loop.
- Idempotent results: a step result or a workflow decision is recorded once, in the same transaction as its event.
- Crash recovery: a janitor that reclaims expired leases, quarantines poison tasks and recovers stalled runs; proven with a worker killed by `SIGKILL`.
- Retry policies with exponential backoff and jitter, step timeouts and a dead letter queue with requeue.
- Durable timers and cron schedules with time zones, overlap policies, pause, resume and backfill.
- Signals, `ctx.select` and queries.
- Cancellation with compensation (`ctx.onCancel`) and forced termination.
- Child workflows with parent close policies, and `ctx.all` and `ctx.allSettled` for fan-out and fan-in.
- Continue-as-new, run chains and history compaction into snapshots.
- Sticky execution: a replay cache per worker and a claim table that routes workflow tasks.
- Workflow versioning with `ctx.patched` and `ctx.deprecatePatch`, and build ids that refuse histories newer than the code.
- HTTP API with namespaced API keys, idempotent start, filtering and keyset paging, an SSE run stream, dead letter endpoints and a generated OpenAPI 3.1 document.
- Quotas and rate limits per namespace, queue depth backpressure for the API, and depth based polling for workers.
- Observability: Prometheus metrics, structured logs with correlation ids, health and readiness probes, OpenTelemetry tracing with one trace per run, and an example Grafana dashboard.
- Run explorer web ui served from the API.
- Chaos suite with six fault scenarios and five invariants (`docs/CHAOS_REPORT.md`), and a benchmark harness with `EXPLAIN ANALYZE` checks (`docs/BENCHMARKS.md`).
- `wf` command line: `dev`, `worker`, `migrate`, `run start|signal|cancel|describe|list` and `example`.
- Examples: `hello`, a payment saga and an ETL pipeline.
- A multi-stage `Dockerfile` and a compose profile that runs it.
- Documentation: README quick start, `docs/CONCEPTS.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/API.md`, `docs/CLI.md`, `docs/VERSIONING.md`, `docs/ROADMAP.md` and 40 architecture decision records.

### Known limitations

See `docs/DEFERRED.md` and `docs/ROADMAP.md`. The main ones: the image and the packages are not published to a registry, `wf` runs from a checkout or from the image and not from an npm package, tracing and quotas are not switched on by the `wf` commands, and the chaos and benchmark runs used a single local Postgres.

[0.1.0]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.1.0
