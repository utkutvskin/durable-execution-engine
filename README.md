# Durable Execution Engine

A durable execution engine: workflows and steps that survive process crashes, written in
TypeScript on top of PostgreSQL.

## Stack

- TypeScript (strict)
- Node 22
- PostgreSQL 16
- pnpm workspaces
- Vitest
- Docker Compose

## Packages

| Path              | Purpose                                      |
| ----------------- | -------------------------------------------- |
| `packages/core`   | event store, replay engine, workflow dsl     |
| `packages/worker` | poll loop, lease renewal, crash recovery     |
| `packages/api`    | rest endpoints, authentication, quotas       |
| `packages/cli`    | developer commands (`wf dev`, `wf run`, ...) |
| `apps/ui`         | run explorer web ui                          |
| `examples`        | example applications (added on day 29)       |

## Quick start

> The full 5-minute quick start lands on day 30 (`docs/BACKLOG.md`). Today's scope is
> the development environment itself.

```sh
pnpm install
docker compose up -d
pnpm run verify
```

`pnpm run verify` runs lint, typecheck and the test suite, in that order.

## Database

Schema changes live as SQL migration pairs under `packages/core/migrations`,
applied by the runner in `packages/core/src/db/migrator.ts`:

```sh
pnpm run migrate:up    # applies every pending migration
pnpm run migrate:down  # reverts the most recently applied migration
```

Both read `DATABASE_URL`, falling back to the same defaults as
`docker-compose.yml` (`postgres://dee:dee@localhost:5432/dee`) when it is
unset. Integration tests do not need a migrated database ahead of time:
each test file opens its own throwaway Postgres schema and migrates it
directly (`packages/core/src/db/test-harness.ts`), so `pnpm run verify`
only needs a reachable Postgres 16, not a pre-migrated one.

## Documentation

- `docs/BACKLOG.md` — the development backlog and the operating instructions for each session.
- `docs/CONVENTIONS.md` — writing and commit conventions.
- `docs/DECISIONS.md` — architecture decision records.
- `docs/API.md` — the HTTP endpoints, authentication, idempotent start, quotas, rate limits and the OpenAPI document.
- `docs/UI.md` — the run explorer web ui, how it is served, what it shows and how it is tested.
- `docs/TRACING.md` — how a run becomes one trace, the span names, sampling and how to look at it in Jaeger.
- `docs/CHAOS_REPORT.md` — the fault injection suite and its latest results: six failure scenarios, ten repetitions each, and the invariant checker behind them.
- `docs/BENCHMARKS.md` — baseline throughput and latency on a single node, the bottlenecks found and fixed, and the `EXPLAIN ANALYZE` index review.
- `docs/OBSERVABILITY.md` — metrics, structured logs, health probes and the example Grafana dashboard.
- `docs/VERSIONING.md` — how to change a workflow without breaking running runs.
- `docs/OUT_OF_SCOPE.md` — what v0.1 explicitly does not cover.
