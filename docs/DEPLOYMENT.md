# Deployment

This page covers running the engine outside a laptop: the container image, the database, how to scale, how to upgrade and what to watch. It describes what v0.1.0 does today; where something is missing it says so.

## What runs

There are three long-running commands, all packaged in the same image:

| Command      | Runs                                                                              | Use                                                       |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `wf serve`   | the HTTP API and the web ui, no worker                                            | production API; what the image starts by default          |
| `wf worker`  | an engine worker (workflow and step tasks, timers, schedules, janitor, compactor) | capacity for your own workflow modules                    |
| `wf migrate` | applies the migrations and exits                                                  | a deployment step, or a one-shot container before rollout |
| `wf dev`     | the API, the web ui, a worker and (if needed) compose Postgres, in one process    | local work only                                           |

All read `DATABASE_URL`. Postgres is the only state: any number of `wf serve` and `wf worker` processes can run at once and any of them can be killed at any time. `wf serve`, `wf worker` and `wf migrate` never start docker compose when `NODE_ENV=production` (the image sets it): an unreachable database is an error.

Neither `wf serve` nor `wf worker` applies migrations unless you pass `--migrate`; on a schema that is behind they refuse to start and say so. Run `wf migrate up` as a step of the rollout. Starting several migrations at once is safe: they take a Postgres advisory lock and the later ones find nothing to do.

The workflows you want to run are loaded with `--module <file>`. `wf worker` refuses to start without a module or an `--example`. `wf serve` needs none; with them it answers 400 to a run of an unknown type. To run your own code, build an image of your own on top of this one that adds your module (see "Your own image" below). The flags of every command are in `docs/CLI.md`; each also reads a `WF_` environment variable, which is how the compose file configures them.

## The image

The `Dockerfile` has three stages: a base with Node 22 and pnpm, a build stage that installs the production dependencies from the lockfile and drops the tests, and a runtime stage that copies the result and runs as the unprivileged `node` user. The image has no build step because `wf` runs the TypeScript sources with Node's built in type stripping, so it needs Node 22.18 or newer; the `node:22-slim` base satisfies that.

```sh
docker build -t dee .
docker run --rm -e DATABASE_URL=postgres://user:pass@db:5432/dee dee migrate up
docker run -d -p 8080:8080 -e DATABASE_URL=postgres://user:pass@db:5432/dee -e WF_API_KEY=dee_choose-a-long-random-key dee
docker run -d -e DATABASE_URL=postgres://user:pass@db:5432/dee dee worker --module /app/my/index.ts --health-port 9100
```

The default command is `serve`. It listens on `0.0.0.0:8080`, writes structured JSON log lines to stdout and answers `GET /health` (the image's `HEALTHCHECK`), `GET /ready` and `GET /metrics`. The worker serves the same three paths on `--health-port`.

With compose, the `engine` profile has three services next to Postgres: `migrate` (runs `wf migrate up` once), `api` (`wf serve`, on `ENGINE_PORT`, default 8080) and `worker` (`wf worker` with both bundled examples and a health port 9100). `api` and `worker` wait for `migrate` to finish. Scale the workers with `--scale worker=3`.

```sh
docker compose --profile engine up -d --build --wait api worker
docker compose --profile engine up -d --scale worker=3 worker
```

Set `WF_API_KEY` (in the environment or a `.env` file next to the compose file) to choose the API key. Without it the first start issues one and logs it once: `docker compose logs api`.

Publishing: CI builds the image on every change to the `Dockerfile` and its inputs (`docker` job) and runs the split services: two migrations started together, an `api` container, two `worker` containers, the payment saga through them, a check that every engine metric has a series, and the compose services. v0.1.0 does not push the image to a registry; see `docs/ROADMAP.md`. Build it yourself and push it to your own registry.

### Your own image

```dockerfile
FROM dee:latest
COPY --chown=node:node my-workflows /app/my-workflows
CMD ["worker", "--module", "/app/my-workflows/index.ts", "--health-port", "9100"]
```

Your module imports `@dee/core`. Place it inside `/app` (for example under `/app/my-workflows`) so Node resolves the workspace links in `/app/node_modules`. The API does not need your module; give `wf serve` the same `--module` only if you want it to reject runs of unknown types.

## The database

- **PostgreSQL 16.** Other versions are not tested. The query plans in `docs/BENCHMARKS.md` were checked on 16.
- **Migrations** run with `wf migrate up` (in the image: `docker run dee migrate up`), as a step before the rollout, or with `--migrate` on `wf serve` and `wf worker`. Concurrent runs are serialized by an advisory lock, so a fleet may all pass `--migrate`. Migrations are forward only in production: `wf migrate down` exists for development, asks for confirmation (`--yes` skips it) and reverts one step at a time.
- **Role.** The engine needs a role that can create tables in its schema (for migrations) and read and write them. Use a separate role for the running processes if you run migrations as a deployment step.
- **Pool.** Each process opens its own connection pool. Count the pools against `max_connections` when you size the database: one `wf serve` or `wf worker` uses up to `--pool-size` connections (default 10), and every extra process adds that again.
- **Durability settings.** The guarantees assume Postgres keeps its commits: leave `fsync` and `synchronous_commit` on. `synchronous_commit = off` can lose the last commits in a crash, which includes events a run already depended on.
- **Backups.** The database is the system of record. Use your usual Postgres backup (base backup plus WAL archiving for point in time recovery). A restore to a point in time is consistent for the engine: runs resume from their events, and tasks, timers and schedules are in the same database. Work done by steps after that point, in other systems, will be done again, which is why steps must be idempotent.
- **Retention.** Event history grows. Closed runs are compacted into a snapshot by the history compactor (`docs/DECISIONS.md` ADR-0029). Turn it on in a worker with `--compact-interval <seconds>`; `--compact-retention` (default one week) is how long a closed run keeps its full history. One worker is enough, but a second one running it does no harm. A compacted run cannot be queried (`RunHistoryCompactedError`).

- **Partitions and archives.** `run_events` has one partition per day of run creation (migration 0037 converts an existing table in place, keeping its rows in `run_events_legacy`). The elected engine creates partitions seven days ahead and, once retention purged every run of a day, drops the day's partition. Pass `--archive-dir <path>` to `wf worker` (or `partitions: { archiveDirectory }` to `startEngine`) to write each partition to `<path>/<partition>.ndjson` first; without it the partition is dropped without a copy. A partition whose archive fails is kept and retried an hour later (`--partition-interval s`). The detach takes a brief exclusive lock on `run_events` and gives up after 5 seconds. Back up the archive directory with your other backups: `wf history import` reads the files back into history exports for `wf replay`.
- **Read replica.** Set `DATABASE_READ_URL` (or `--database-read-url`) on `wf serve` to a streaming replica of the database, and the API serves run lists, run pages, histories, the UI's reads and `/metrics` from it. A run the same process started, signalled or changed in the last ten seconds is read from the primary, and so is a run the replica does not have yet. Behind a load balancer without session affinity, a client may read another process's write only after the replica caught up.

## Session connections, PgBouncer and wake-ups

An engine (`startEngine`, and so `wf worker` and `wf serve`) holds up to two connections of its own besides its pool:

- **The leader election session.** The timer, schedule, janitor and compactor loops of a queue run on one engine at a time. Every engine tries `pg_try_advisory_lock` on a dedicated session once per `leaderLeaseMs` (default 1000 ms); the one that holds the lock runs the loops and checks once per period that its session is alive. The lock is a session lock, so it is released the moment the leader's connection closes: a killed leader is replaced within two lease periods, and a leader whose session is lost stops its loops at once. Turn it off with `leaderElection: false`, and every engine runs the loops as before.
- **The wake-up session**, only with `wakeups: true`. It runs `LISTEN dee_wakeup` and wakes the engine's workers when a task is enqueued on its queue, so an idle engine starts work in milliseconds instead of after its poll backoff (up to 500 ms per hop). Polling stays on as the fallback: a lost notification costs latency, never a task.

Both sessions are opened outside the pool, with the pool's settings, so they take no pool slot. Count them against `max_connections`: two more per engine with wake-ups, one without.

**Wake-ups are sent only by sessions that ask for them.** The `tasks` insert trigger notifies once per transaction and queue when the inserting session has `dee.notify_wakeups` set to `on`, and does nothing otherwise, so the commit of a busy database does not pay for notifications nobody listens to. Turn it on for every process that enqueues work (the API, the workers, an embedding service): `createPool(env, { notifyWakeups: true })`, or for every session at once with `alter database <name> set dee.notify_wakeups = on` (or `alter role ... set`). Notifications are delivered to every listening session of the database, and each listener keeps those of its own schema and queue.

**PgBouncer in transaction mode** hands each transaction to any server connection, so session state does not survive between transactions. That breaks the two sessions above: a session advisory lock would stay on a server connection other clients then use, and a `LISTEN` would be lost. It does not break the pool, because the engine keeps no session state on pooled connections (its advisory locks there are transaction scoped). With PgBouncer in transaction mode:

- point the pool at PgBouncer and pass `sessionConnectionString` to `startEngine` with a URL that reaches Postgres directly (or a PgBouncer pool in session mode), so the election and the listener get real sessions;
- set `search_path` the same way on both, because the lock and the notifications are scoped to the schema the session sees;
- `options` startup parameters such as `-c dee.notify_wakeups=on` are refused by PgBouncer unless they are in `ignore_startup_parameters`, so set `dee.notify_wakeups` with `alter database` or `alter role` instead.

## Scaling

- **More capacity for steps:** run more `wf worker` processes. Tasks are leased with `for update skip locked`, so workers do not block each other. The timer, schedule, janitor and compactor loops run on one elected engine per queue (see "Session connections" below), so adding workers adds no background work.
- **More API capacity:** run more `wf serve` processes behind a load balancer. The API is stateless. The per namespace rate limit is held in each process's memory, so the effective rate is the sum over processes (ADR-0033).
- **Sticky execution:** a worker keeps live workflows in memory. After each decision that leaves a run open it claims the run in Postgres (`run_stickiness`, 60 seconds by default), and the other workers skip that run's workflow tasks until the claim expires or is released; a claim is released when the run closes and when the worker stops. With 3 workers 100 percent of the decisions after a run's first came from the cache in `pnpm run bench:sticky`, against 58 percent without the claims (`docs/BENCHMARKS.md`). A worker that disappears costs one full replay on the next worker after the claim expires, not an error.
- **Limits of one database:** measured on one 4 core machine, about 700 steps per second end to end and about 1,000 runs started per second (`docs/BENCHMARKS.md`). Beyond that the engine does not shard.

## Security

- Every `/v1` endpoint needs `Authorization: Bearer <key>`. Keys are scoped to one namespace and stored as a sha256 hash. Terminate TLS in front of the API (a reverse proxy or load balancer); the API itself speaks plain HTTP.
- `wf serve` takes its key from `WF_API_KEY` (registered for the namespace, stored as a hash) or keeps the keys the namespace has; only a namespace without any key gets a new one, logged once. Pass the key as a secret of your platform, not in an image. `wf dev` issues a new key on every start and writes it to `.wf/dev.json` (mode 0600). These keys have the `admin` scope; issue narrower ones for applications and dashboards (`wf keys issue <namespace> --scope operate|read`, with `--expires-in` for keys that should not live forever), revoke keys you do not need (`wf keys revoke`), and read who did what with `wf audit list`. Issuing a key no longer creates its namespace; `wf namespace create` does.
- `/health`, `/ready` and `/openapi.json` are not authenticated. `/metrics` is not either unless the server is given a `metricsToken`; set one with `--metrics-token` (on a worker too), or keep the endpoint on a private network or restrict it at the proxy. The health port of a worker has the same three paths and the same rule. Failed authentication is throttled per client address (`docs/API.md`, hardening), and streams are capped per namespace.
- Run the container as the unprivileged user (the image does) and give it only the database credential it needs.
- Workflow and step payloads are stored in Postgres as JSON, in clear text unless a payload codec is configured. Set `WF_ENCRYPTION_KEYS` to comma separated `id:base64key` entries (32 byte keys, for example `k1:$(openssl rand -base64 32)`) on `wf serve` and on every `wf worker`, the same value on all of them: payloads are then encrypted with AES-256-GCM before they reach the database, and only ids, types, timestamps, errors, search attributes and the memo stay readable. The last entry encrypts unless `WF_ENCRYPTION_ACTIVE_KEY` names another. To rotate, add a new key at the end, deploy it everywhere, and keep the old keys as long as any stored payload uses them: old runs stay readable, new payloads use the new key. `WF_PAYLOAD_GZIP=on` compresses before encrypting. The keys are read from the environment only, never from flags. A worker without the keys cannot run an encrypted run (its workflow code would see ciphertext), so roll keys out to the workers first. Error messages are not encrypted, so do not put secrets in them.
- `WF_MASK_FIELDS` (comma separated object keys) masks those keys in every log line of `wf serve` and `wf worker` and in what the codec endpoint answers, which is what the UI and `wf run describe` show. Log lines never carry an encoded payload, only its codec name. The stored payload keeps the real value, which a replay needs. The API's own request log carries the method, path, status and duration only.

## Upgrading

1. Read `CHANGELOG.md` for migrations and behavior changes.
2. Back up the database.
3. Run `wf migrate` with the new version. Migrations add tables, columns and indexes; the previous version keeps working against them during a rolling restart unless the changelog says otherwise.
4. Roll the processes one at a time. A stopping worker finishes the tasks it holds (`SIGTERM` drains) and its leases are released; if it is killed instead, the janitor reclaims them after the visibility timeout.
5. Changing workflow code while runs are open needs care: see `docs/VERSIONING.md`.

## Observability

- **Metrics:** `GET /metrics` in the Prometheus text format on the API and, with `--health-port`, on every worker: queue depth, task latency, step retries, timer lag, active workers, runs by status, quarantined tasks and reclaimed leases. Six of them are read from Postgres on every scrape, so each process shows the fleet. Two belong to the process: `dee_task_latency_seconds` is filled by the worker that settled the task, and `dee_leases_reclaimed_total` counts the leases the janitor of that worker took back. Scrape every worker and sum them; the API has no task latency because it settles no tasks. Idle queues of a process show a zero series for queue depth and quarantined tasks. An example Grafana dashboard is in `docs/grafana/dee-overview.json`. See `docs/OBSERVABILITY.md`.
- **Logs:** structured JSON lines (`--log-format text` for a person), with a correlation id taken from the `X-Correlation-Id` request header or generated. `--log-level` filters.
- **Tracing:** one trace per run, exported over OTLP/HTTP. Pass `--otlp-endpoint` (or `WF_OTLP_ENDPOINT`) to `wf serve` and `wf worker`, and `--sampling-ratio` to sample. See `docs/TRACING.md`.
- **Probes:** `/health` for liveness, `/ready` for readiness (the database answers). Both exist on the API and on a worker with a health port.
- **Alerts worth having:** queue depth rising for several minutes, timer lag above a few seconds, any quarantined task, a non zero dead letter queue, and `/ready` failing.

## Embedding the engine in your own service

`wf` is a thin wrapper. A service that wants its own process layout (API in one deployment, workers in another, tracing and quotas on) uses the libraries directly:

```ts
import { createPool, migrateUp } from "@dee/core";
import { createApiServer } from "@dee/api";
import { startEngine } from "@dee/worker";
```

`createApiServer(pool, options)` takes the quota guard, the logger, the metrics and the tracing provider; `startEngine({ pool, workflows, steps, ... })` runs the worker and the loops. `packages/cli/src/serve-environment.ts` (the API) and `packages/cli/src/commands/process.ts` (the worker) are short, complete examples of wiring them together. `startEngine` returns `engine.metrics`, which a service can hand to its own `/metrics`.

## Known gaps

The list is in `docs/DEFERRED.md`. The ones that matter most in production: no registry image and no published npm package, no admin surface for keys and namespaces, the failed authentication throttle and the rate limit are per process, and no run of the chaos suite against a restarted or remote Postgres. The split compose services and the image were run in CI, not on a Kubernetes cluster or another orchestrator.
