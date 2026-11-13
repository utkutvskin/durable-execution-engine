# Command line

The `wf` command lives in `packages/cli`. In this repository it is on the path after `pnpm install` (`npx wf ...`), or run it directly with `node packages/cli/bin/wf.js ...`. Installed from the packed or published packages it runs the compiled `dist` on Node 22. In a checkout, where `pnpm run build` has not run, it falls back to the TypeScript sources through Node's built in type stripping (Node 22.18 or newer) with the `development` export condition.

```sh
npx wf help
```

## Commands

| Command                                        | What it does                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `wf dev`                                       | Postgres, migrations, api, web ui and a worker in one process                   |
| `wf serve`                                     | The api and the web ui without a worker, for production                         |
| `wf worker`                                    | A worker for your modules against the database, without an api                  |
| `wf migrate [up\|down] [--steps n] [--yes]`    | Applies pending migrations, or reverts the last `n` (default 1, asks first)     |
| `wf run start <type>`                          | Starts a run: `--input <json>`, `--idempotency-key <k>`, `--wait`, `--json`     |
| `wf run signal <runId> <name>`                 | Sends a signal: `--payload <json>`                                              |
| `wf run update <runId> <name>`                 | Sends an update and prints its result: `--argument`, `--update-id`, `--wait-ms` |
| `wf run query <runId> <name>`                  | Answers a query from the run's current state: `--argument <json>`               |
| `wf run cancel <runId>`                        | Requests a graceful cancellation: `--reason <text>`                             |
| `wf run describe <runId>`                      | Shows a run: `--history` adds its events, `--json` prints json                  |
| `wf run list`                                  | Lists runs: `--status`, `--type`, `--limit`, `--cursor`                         |
| `wf history export <runId>`                    | Prints the run's whole history as a history export: `--out <file>`              |
| `wf replay --module <path> <file...>`          | Replays history exports against your code, exits 1 on non-determinism           |
| `wf example <payment-saga\|etl-pipeline\|all>` | Runs a bundled example end to end (see `docs/EXAMPLES.md`)                      |

`wf run update` prints the handler's result as JSON and exits 0. It exits 1 when the handler threw (the error goes to stderr), when the wait ended before the handler ran, and when the validator rejected the argument, which writes nothing. `--json` prints the whole answer, `--wait-ms` takes 0 to 60000. See `docs/API.md` for the semantics. `--limit` must be a whole number from 1 to 200 (usage error otherwise). `--wait` polls the run and, when the API answers 429, sleeps for the `Retry-After` it gave (never past the wait timeout) instead of failing. Run ids are percent encoded in URLs, `wf run describe --history` reads every history page, and an API answer that is not JSON (a proxy's error page) is reported as one line with its status and a short preview, with no stack trace.

## History export and replay

`wf history export <runId>` reads every page of the run's history through the API and prints one JSON document (`format: "dee.history"`, `formatVersion`, `runId`, `workflowType`, `exportedAt`, and `events`, each with its `sequenceNumber`, `createdAt`, event format `version` and the `event`). `--out <file>` writes it to a file instead. A run whose history was compacted has lost its oldest events and is refused.

`wf replay --module <path> <file...>` (or `--example <name>`) replays each exported history against the workflows of the module, without a database and without running any step. Every command the history recorded must be issued again in the same order with the same type and input, and a history that closed its run must close it the same way. A history that is still open may end with new commands. One line is printed per file:

```
ok    run 0f6a... (orders/run-1.json): 12 events replayed
FAIL  run 9b2c... (orders/run-2.json): non determinism at event 6 (step_scheduled): non-deterministic replay at "step-2": ...
1 passed, 1 failed
```

The exit code is 0 when every file replays and 1 when one does not. `--json` prints the whole report, `--build-id <id>` names the replaying build in a version mismatch. The same check is available in tests as `replayHistories(workflows, histories)` from `@dee/core`; see `docs/STABILITY.md` for how to keep a set of exported histories as a gate in CI.

Exit codes: 0 on success, 1 when a command failed (or `--wait` ended in a state other than `COMPLETED`), 2 for a usage error such as an unknown flag.

## `wf dev`

`wf dev` is the one command for local work:

1. It reads `DATABASE_URL` (or `--database-url`), falling back to the compose defaults. When the database does not answer and a `docker-compose.yml` is found at or above the working directory, it runs `docker compose up -d --wait postgres` and waits for it.
2. It applies the pending migrations.
3. It starts the api and the web ui on `--port` (default 8080, `0` picks a free port) and an engine that runs your workflows.
4. It issues a fresh api key for the namespace (`--namespace`, default `default`), prints it, and writes the api address and key to `.wf/dev.json` in the working directory, so `wf run ...` needs no flags there.
5. It runs until `SIGINT` or `SIGTERM`, then stops the api and drains the worker.

The api of `wf dev` knows the workflows of the loaded modules: it answers updates and queries from their code, and it refuses to start a run of a workflow type none of them defines (400 `unknown_workflow_type`), like `wf serve --module`.

Which workflows run is chosen with `--module <file>` (repeatable) and `--example <name>` (repeatable). Without either, both bundled examples are loaded, so the first start has something to try:

```sh
npx wf dev &
npx wf run start payment-saga --input '{"orderId":"o-1","customerId":"c-1","amountCents":4999}' --wait
npx wf run list
```

The ui is at `http://127.0.0.1:8080/ui/`; sign in with the printed key.

## Workflow modules

`wf dev --module` and `wf worker --module` import a file that exports the definitions to run, as named exports or as the default export:

```ts
import { defineStep, defineWorkflow } from "@dee/core";

export const workflows = [
  defineWorkflow("greet", async (ctx, input: { name: string }) =>
    ctx.step<string>("greeting.build", input),
  ),
];

export const steps = [
  defineStep("greeting.build", { handler: ({ name }: { name: string }) => `hello ${name}` }),
];
```

Two definitions of the same workflow type or step type, across all loaded modules, are refused at start. `wf worker` requires at least one module; its engine also runs the timer, schedule and janitor loops, which are safe to run in several processes at once.

## `wf serve` and `wf worker`

These are the production processes. `wf dev` stays the local all-in-one command. Neither starts docker compose when `NODE_ENV=production`; an unreachable database is then an error that says so. Neither applies migrations by default: they refuse to start on a schema that is behind and name `wf migrate up`; `--migrate` applies the migrations first (concurrent callers take turns under a database lock). Every flag also reads an environment variable named `WF_` plus the flag in upper case with `_` for `-` (`--pool-size` is `WF_POOL_SIZE`); the flag wins.

Flags of both:

| Flag                  | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `--pool-size n`       | Database connections of the process (1 to 1000, default the `pg` default of 10)   |
| `--log-level l`       | `debug`, `info`, `warn` or `error` (default `info`)                               |
| `--log-format f`      | `json` (default), one object per line, or `text`                                  |
| `--otlp-endpoint url` | Export traces to this OTLP HTTP endpoint (service name `wf-serve` or `wf-worker`) |
| `--sampling-ratio r`  | Share of new traces recorded, 0 to 1 (default 1)                                  |
| `--migrate`           | Apply pending migrations before starting                                          |
| `--database-url url`  | Connection string (default `DATABASE_URL`)                                        |

`wf serve` also takes `--port n` (default 8080), `--host h` (default `0.0.0.0`), `--namespace name` (default `default`), `--queue name`, optional `--module` and `--example` (with them, starting a run of an unknown type answers 400), and the limits `--max-concurrent-runs n`, `--max-pending-tasks n`, `--rate-per-second n`, `--burst n` (stored for the namespace; only the ones you pass change), `--max-queue-depth n` (writes answer 503 while the queue holds that many tasks), `--metrics-token t` and `--metrics-cache-ms n`.

The api key of `wf serve`: `WF_API_KEY` is registered for the namespace when it is set (it must start with `dee_`, hold 20 to 200 letters, digits, `-` or `_`, and not be revoked or belong to another namespace). Without it the namespace keeps its keys, and a namespace without any gets one new key, logged once as a `warn` line. Every line `wf serve` writes is a log line, including the startup lines.

`wf worker` also takes `--queue name`, `--concurrency n`, `--health-port n` (serves `/health`, `/ready` and `/metrics`; `--health-host h`, default `0.0.0.0`, and `--metrics-token t`), and the compactor schedule `--compact-interval s` (turns it on), `--compact-retention s` (age of a closed run before it is compacted, default 604800), `--compact-tail-events n` (default 20) and `--compact-batch n`. The metrics of a worker carry its task latency histogram and the leases its janitor reclaimed; the gauges read from the database are the same in every process.

Both stop on `SIGINT` or `SIGTERM`; a worker finishes the tasks it holds first and exits 1 if it had to drop some.

## Api address and key

The `wf run` commands find the api in this order: `--api-url` and `--api-key`, then `WF_API_URL` and `WF_API_KEY`, then `.wf/dev.json` in the working directory. Without a key the command stops and says so. `.wf/` is ignored by git.

## `wf migrate`

`wf migrate` applies every pending migration and prints the id of each. A current schema prints `nothing to apply, the schema is current`. `wf migrate down --steps 2` reverts the last two, and it can destroy data, so it asks `revert the last 2 migration(s) on host:port/db? this can delete data.` on a terminal. Pass `--yes` to answer for it; without a terminal and without `--yes` it exits 2 and reverts nothing. Two `wf migrate up` processes started together both succeed: they take a Postgres advisory lock, so one applies and the other finds nothing to do. Like `wf dev`, it starts the compose Postgres when the database is not reachable, except when `NODE_ENV=production`.

`.wf/dev.json` holds an api key, so `wf dev` writes it with mode 0600 in a `.wf` directory of mode 0700.
