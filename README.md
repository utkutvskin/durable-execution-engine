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

## Documentation

- `docs/BACKLOG.md` — the development backlog and the operating instructions for each session.
- `docs/CONVENTIONS.md` — writing and commit conventions.
- `docs/DECISIONS.md` — architecture decision records.
- `docs/OUT_OF_SCOPE.md` — what v0.1 explicitly does not cover.
