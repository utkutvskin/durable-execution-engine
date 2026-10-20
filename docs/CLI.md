# Command line

The `wf` command lives in `packages/cli`. In this repository it is on the path after `pnpm install` (`npx wf ...`), or run it directly with `node packages/cli/bin/wf.js ...`. It runs the TypeScript sources through Node's built in type stripping, so it needs Node 22.18 or newer, and no build step is involved.

```sh
npx wf help
```

## Commands

| Command                                        | What it does                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `wf dev`                                       | Postgres, migrations, api, web ui and a worker in one process               |
| `wf worker`                                    | A worker for your modules against the database, without an api              |
| `wf migrate [up\|down] [--steps n]`            | Applies pending migrations, or reverts the last `n` (default 1)             |
| `wf run start <type>`                          | Starts a run: `--input <json>`, `--idempotency-key <k>`, `--wait`, `--json` |
| `wf run signal <runId> <name>`                 | Sends a signal: `--payload <json>`                                          |
| `wf run cancel <runId>`                        | Requests a graceful cancellation: `--reason <text>`                         |
| `wf run describe <runId>`                      | Shows a run: `--history` adds its events, `--json` prints json              |
| `wf run list`                                  | Lists runs: `--status`, `--type`, `--limit`, `--cursor`                     |
| `wf example <payment-saga\|etl-pipeline\|all>` | Runs a bundled example end to end (see `docs/EXAMPLES.md`)                  |

Exit codes: 0 on success, 1 when a command failed (or `--wait` ended in a state other than `COMPLETED`), 2 for a usage error such as an unknown flag.

## `wf dev`

`wf dev` is the one command for local work:

1. It reads `DATABASE_URL` (or `--database-url`), falling back to the compose defaults. When the database does not answer and a `docker-compose.yml` is found at or above the working directory, it runs `docker compose up -d --wait postgres` and waits for it.
2. It applies the pending migrations.
3. It starts the api and the web ui on `--port` (default 8080, `0` picks a free port) and an engine that runs your workflows.
4. It issues a fresh api key for the namespace (`--namespace`, default `default`), prints it, and writes the api address and key to `.wf/dev.json` in the working directory, so `wf run ...` needs no flags there.
5. It runs until `SIGINT` or `SIGTERM`, then stops the api and drains the worker.

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

## Api address and key

The `wf run` commands find the api in this order: `--api-url` and `--api-key`, then `WF_API_URL` and `WF_API_KEY`, then `.wf/dev.json` in the working directory. Without a key the command stops and says so. `.wf/` is ignored by git.

## `wf migrate`

`wf migrate` applies every pending migration and prints the id of each. A current schema prints `nothing to apply, the schema is current`. `wf migrate down --steps 2` reverts the last two. Like `wf dev`, it starts the compose Postgres when the database is not reachable.
