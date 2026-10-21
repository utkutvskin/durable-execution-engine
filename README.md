# Durable Execution Engine

A durable execution engine: workflows and steps that survive process crashes, written in
TypeScript on top of PostgreSQL. Every decision a workflow makes is an event in an append-only log; when a worker dies, another one replays the log and carries on exactly where the first stopped.

What you get in v0.1.0: steps with retries and a dead letter queue, durable timers and cron schedules, signals and queries, cancellation with compensation, child workflows, continue-as-new, workflow versioning, an HTTP API with keys, namespaces and quotas, a run explorer web ui, metrics, tracing and a command line. Read `docs/CONCEPTS.md` for the ideas and `docs/ARCHITECTURE.md` for the moving parts.

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
| `examples`        | hello, a payment saga and an etl pipeline    |

## Quick start

You need Node 22.18 or newer, pnpm 10 and a PostgreSQL 16 that you can reach: either Docker, or a database of your own (set `DATABASE_URL`, default `postgres://dee:dee@localhost:5432/dee`). The steps below take about five minutes.

**1. Get the code and the dependencies**

```sh
git clone https://github.com/utkutvskin/durable-execution-engine.git
cd durable-execution-engine
pnpm install
```

**2. Start the environment** (terminal one)

```sh
npx wf dev --module examples/hello/src/index.ts --example payment-saga
```

`wf dev` starts the compose Postgres when the database does not answer, applies the migrations, and starts the API, the web ui and a worker in one process. It prints an API key and saves the address and the key to `.wf/dev.json`. The workflow in `examples/hello/src/index.ts` is a step followed by a one second durable timer; `--example payment-saga` loads the payment saga for step 4.

**3. Run a workflow** (terminal two, same directory)

```sh
npx wf run start hello --input '{"name":"ada"}' --wait
```

The command waits for the run and prints it: status `COMPLETED` and the result `{"greeting":"hello, ada"}`. Look at what happened with `npx wf run describe <runId> --history`, or open `http://127.0.0.1:8080/ui/` and sign in with the printed key.

**4. Watch it survive a crash**

Start the payment saga, stop the process with `Ctrl-C` while it waits for an approval, start the same `npx wf dev ...` command again and send the signal. The run carries on from its history:

```sh
npx wf run start payment-saga --input '{"orderId":"o-1","customerId":"c-1","amountCents":250000}'
npx wf run signal <runId> approval --payload '{"approved":true}'
npx wf run describe <runId>
```

**5. Run both bundled examples end to end**

```sh
npx wf example all
```

### With Docker

The image runs the same `wf` command. It needs a database:

```sh
docker compose up -d --wait postgres
docker compose --profile engine up --build engine
```

Or build and run it by hand with `docker build -t dee .` and `docker run -p 8080:8080 -e DATABASE_URL=... dee`. See `docs/DEPLOYMENT.md`.

### Your own workflow

A module exports `workflows` and `steps`. Copy `examples/hello/src/index.ts`, change it and start it with `npx wf dev --module path/to/your-module.ts`. Workflow code must be deterministic; `docs/CONCEPTS.md` explains what that allows and what it forbids.

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

Start here:

- `docs/CONCEPTS.md` — determinism, replay, idempotency, retries, timers, signals, versioning.
- `docs/ARCHITECTURE.md` — the packages, the data model, the life of a run, with diagrams.
- `docs/DEPLOYMENT.md` — running it in production: the image, the database, scaling, upgrades, backups.
- `docs/API.md` — the HTTP API reference, authentication, idempotent start, quotas and the OpenAPI document (`/openapi.json`).
- `docs/CLI.md` — the `wf` command line.
- `docs/EXAMPLES.md` — the payment saga and the etl pipeline.
- `CHANGELOG.md` and `docs/ROADMAP.md` — what v0.1.0 contains and what comes next.

Reference and background:

- `docs/VERSIONING.md` — how to change a workflow without breaking running runs.
- `docs/OBSERVABILITY.md` — metrics, structured logs, health probes and the example Grafana dashboard.
- `docs/TRACING.md` — how a run becomes one trace, the span names, sampling and how to look at it in Jaeger.
- `docs/UI.md` — the run explorer web ui.
- `docs/CHAOS_REPORT.md` — the fault injection suite and its latest results.
- `docs/BENCHMARKS.md` — baseline throughput and latency on a single node.
- `docs/DECISIONS.md` — architecture decision records.
- `docs/DEFERRED.md` — what was named in a day's scope and not finished.
- `docs/OUT_OF_SCOPE.md` — what v0.1 explicitly does not cover.
- `docs/CONVENTIONS.md` and `docs/BACKLOG.md` — writing conventions and the development backlog.

## Development

```sh
pnpm install
docker compose up -d --wait postgres
pnpm run verify
```

`pnpm run verify` runs lint, typecheck and the test suite, in that order.

## License

Not yet licensed: the package metadata says `UNLICENSED`. See `docs/ROADMAP.md`.
