# Deployment

This page covers running the engine outside a laptop: the container image, the database, how to scale, how to upgrade and what to watch. It describes what v0.1.0 does today; where something is missing it says so.

## What runs

There are two long-running commands, both packaged in the same image:

| Command     | Runs                                                                               | Use                                                           |
| ----------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `wf dev`    | the HTTP API, the web ui and an engine worker, in one process                      | the all-in-one process; also what the image starts by default |
| `wf worker` | an engine worker (workflow and step tasks, timers, schedules, janitor) with no API | more capacity for your own workflow modules                   |

Both read `DATABASE_URL`. Postgres is the only state: any number of either process can run at once and any of them can be killed at any time.

The workflows you want to run are loaded with `--module <file>`. Without a module `wf dev` loads the bundled examples and `wf worker` refuses to start. To run your own code, build an image of your own on top of this one that adds your module (see "Your own image" below).

## The image

The `Dockerfile` has three stages: a base with Node 22 and pnpm, a build stage that installs the production dependencies from the lockfile and drops the tests, and a runtime stage that copies the result and runs as the unprivileged `node` user. The image has no build step because `wf` runs the TypeScript sources with Node's built in type stripping, so it needs Node 22.18 or newer; the `node:22-slim` base satisfies that.

```sh
docker build -t dee .
docker run --rm -p 8080:8080 -e DATABASE_URL=postgres://user:pass@db:5432/dee dee
```

The default command is `dev --host 0.0.0.0 --port 8080`. It applies the migrations on start, prints the namespace and a fresh API key to its log, and answers `GET /health` (the image's `HEALTHCHECK`), `GET /ready` and `GET /metrics`. Override the command to run a worker: `docker run dee worker --module /app/my/index.ts`.

With compose: `docker compose up -d --wait postgres` and then `docker compose --profile engine up --build engine`.

Publishing: CI builds the image on every change to the `Dockerfile` and its inputs (`docker` job). v0.1.0 does not push the image to a registry; see `docs/ROADMAP.md`. Build it yourself and push it to your own registry.

### Your own image

```dockerfile
FROM dee:latest
COPY --chown=node:node my-workflows /app/my-workflows
CMD ["dev", "--host", "0.0.0.0", "--port", "8080", "--module", "/app/my-workflows/index.ts"]
```

Your module imports `@dee/core`. Place it inside `/app` (for example under `/app/my-workflows`) so Node resolves the workspace links in `/app/node_modules`.

## The database

- **PostgreSQL 16.** Other versions are not tested. The query plans in `docs/BENCHMARKS.md` were checked on 16.
- **Migrations** run at the start of `wf dev`. Run them ahead of a rollout with `wf migrate` (in the image: `docker run dee migrate`). Migrations are forward only in production: `wf migrate down` exists for development and reverts one step at a time.
- **Role.** The engine needs a role that can create tables in its schema (for migrations) and read and write them. Use a separate role for the running processes if you run migrations as a deployment step.
- **Pool.** Each process opens its own connection pool. Count the pools against `max_connections` when you size the database: one `wf dev` or `wf worker` uses up to the pool size in connections, and every extra process adds that again.
- **Durability settings.** The guarantees assume Postgres keeps its commits: leave `fsync` and `synchronous_commit` on. `synchronous_commit = off` can lose the last commits in a crash, which includes events a run already depended on.
- **Backups.** The database is the system of record. Use your usual Postgres backup (base backup plus WAL archiving for point in time recovery). A restore to a point in time is consistent for the engine: runs resume from their events, and tasks, timers and schedules are in the same database. Work done by steps after that point, in other systems, will be done again, which is why steps must be idempotent.
- **Retention.** Event history grows. Closed runs can be compacted into a snapshot with the history compactor (`createHistoryCompactor`, `docs/DECISIONS.md` ADR-0029); the CLI does not schedule it yet.

## Scaling

- **More capacity for steps:** run more `wf worker` processes. Tasks are leased with `for update skip locked`, so workers do not block each other, and the timer, schedule and janitor loops are safe in many processes.
- **More API capacity:** run more `wf dev` processes behind a load balancer. The API is stateless. The per namespace rate limit is held in each process's memory, so the effective rate is the sum over processes (ADR-0033).
- **Sticky execution:** a worker keeps live workflows in memory and the queue prefers to send a run's next workflow task to the worker that has it. A worker that disappears costs one full replay on the next worker, not an error.
- **Limits of one database:** measured on one 4 core machine, about 700 steps per second end to end and about 1,000 runs started per second (`docs/BENCHMARKS.md`). Beyond that the engine does not shard.

## Security

- Every `/v1` endpoint needs `Authorization: Bearer <key>`. Keys are scoped to one namespace and stored as a sha256 hash. Terminate TLS in front of the API (a reverse proxy or load balancer); the API itself speaks plain HTTP.
- `wf dev` issues a new key on every start and prints it to its log; earlier keys stay valid. In production, treat that log line as a secret and revoke keys you do not need (`ApiKeyStore.revoke`). There is no admin endpoint for keys yet.
- `/health`, `/ready`, `/metrics` and `/openapi.json` are not authenticated. Keep them on a private network or restrict them at the proxy.
- Run the container as the unprivileged user (the image does) and give it only the database credential it needs.
- Workflow and step payloads are stored in Postgres as JSON. Do not put secrets in a workflow input; pass a reference and fetch the secret in the step. `maskSensitiveFields` can mask known field names in logs and the ui.

## Upgrading

1. Read `CHANGELOG.md` for migrations and behavior changes.
2. Back up the database.
3. Run `wf migrate` with the new version. Migrations add tables, columns and indexes; the previous version keeps working against them during a rolling restart unless the changelog says otherwise.
4. Roll the processes one at a time. A stopping worker finishes the tasks it holds (`SIGTERM` drains) and its leases are released; if it is killed instead, the janitor reclaims them after the visibility timeout.
5. Changing workflow code while runs are open needs care: see `docs/VERSIONING.md`.

## Observability

- **Metrics:** `GET /metrics` in the Prometheus text format: queue depth, task latency, step retries, timer lag, active workers, runs by status, quarantined tasks and reclaimed leases. An example Grafana dashboard is in `docs/grafana/dee-overview.json`. See `docs/OBSERVABILITY.md`.
- **Logs:** structured JSON lines with a correlation id taken from the `X-Correlation-Id` request header or generated.
- **Tracing:** one trace per run, exported over OTLP/HTTP. Tracing is enabled by passing a provider when you embed the engine; the `wf` commands do not enable it yet. See `docs/TRACING.md`.
- **Alerts worth having:** queue depth rising for several minutes, timer lag above a few seconds, any quarantined task, a non zero dead letter queue, and `/ready` failing.

## Embedding the engine in your own service

`wf` is a thin wrapper. A service that wants its own process layout (API in one deployment, workers in another, tracing and quotas on) uses the libraries directly:

```ts
import { createPool, migrateUp } from "@dee/core";
import { createApiServer } from "@dee/api";
import { startEngine } from "@dee/worker";
```

`createApiServer(pool, options)` takes the quota guard, the logger, the metrics and the tracing provider; `startEngine({ pool, workflows, steps, ... })` runs the worker and the loops. `packages/cli/src/dev-environment.ts` is a short, complete example of wiring them together.

## Known gaps in v0.1.0

The list is in `docs/DEFERRED.md`. The ones that matter most in production: no registry image and no published npm package, no API-only command, no admin surface for keys and quotas, tracing and quotas not switched on by the `wf` commands, no run of the chaos suite against a restarted or remote Postgres.
