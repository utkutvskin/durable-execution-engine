# Upgrading from 0.1 to 0.2

This guide takes a database and its processes from v0.1.1 (or v0.1.0) to v0.2.0 without losing a run that is still open. Runs that wait for a signal, sleep on a timer, wait for a child, wait for a step retry or sit in the queue all carry on after the upgrade, and steps that already finished are not run again.

The guide is checked by a test: `test/upgrade/upgrade-from-v0.1.1.test.ts` restores a database that the v0.1.1 engine left behind, applies the 0.2 migrations and lets the 0.2 engine finish every run (see [How this is tested](#how-this-is-tested)).

## What changes in the database

v0.2.0 adds 19 migrations, `0021_start_workflow_function` to `0039_reset_and_batches`, to the 20 of v0.1.1. They are applied in order by the same runner as before (`wf migrate up`). Three of them change existing rows rather than only adding tables, columns and indexes:

| Migration                        | What it does to existing data                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0031_one_pending_workflow_task` | Merges the pending workflow tasks of a run into one, so a run has at most one decision waiting.                                                                                                                                                                                      |
| `0037_partitioned_run_events`    | Turns `run_events` into a table partitioned by the day each run was created. The old rows stay where they are, as the partition `run_events_legacy`, after a pass that writes each event's `run_created_at`. This pass takes time in proportion to the number of events (see below). |
| `0038_key_scopes_and_audit_log`  | Gives every existing api key the scope `admin`, which keeps it working exactly as before. New keys need a scope.                                                                                                                                                                     |

Every migration runs in its own transaction, so one that fails leaves the database at the previous one, and running `wf migrate up` again continues from there.

`0037` holds a lock on `run_events` while it rewrites it. On the 4-core machine of `docs/BENCHMARKS.md`, a database of 100,000 runs and their events converts in about 15 seconds (`packages/worker/src/engine/partition-migration.integration.test.ts`). Plan the downtime from the number of rows in `run_events`.

## Old and new processes cannot run side by side

A v0.1 worker or API writes `run_events` without the partition key that `0037` makes mandatory, and it does not know the SQL functions the 0.2 hot paths call. Once the 0.2 migrations are applied, every v0.1 process fails its writes. A rolling upgrade across 0.1 and 0.2 is therefore not supported: stop every v0.1 process, migrate, then start the 0.2 processes. Within 0.2, the usual rolling restart of `docs/DEPLOYMENT.md` applies again.

## Steps

1. **Check the history of your workflows against 0.2.** Export a few open and closed runs of each workflow type with `wf history export <runId> --out <file>` while 0.1 is still running, and replay them against your workflow module with the 0.2 command line: `npx wf replay --module <path> <file...>`. Every line must say `ok`. The event format did not change in a way that breaks replay, but your own workflow code may have changed since those runs started; `docs/VERSIONING.md` explains how to change it safely.
2. **Stop every v0.1 process.** Send `SIGTERM` to each worker and API process, or `docker compose --profile engine stop api worker`. A worker finishes the tasks it holds and releases its leases. A process that was killed instead leaves its leases behind; the 0.2 janitor reclaims them after the visibility timeout, so nothing is lost either way, it only takes longer.
3. **Back up the database.** `pg_dump --format=custom --file=dee-0.1.dump "$DATABASE_URL"`. The down migrations exist, but restoring this dump is the way back to 0.1.
4. **Apply the migrations with 0.2.** `npx wf migrate up` (or `docker compose --profile engine run --rm migrate` with the 0.2 image). It prints each migration it applies, `0021_start_workflow_function` to `0039_reset_and_batches`. Running it again prints `nothing to apply, the schema is current`.
5. **Start the 0.2 processes.** `wf serve` and `wf worker` refuse to start on a schema that is behind and name `wf migrate up`, so a forgotten step 4 is caught here.
6. **Watch the open runs continue.** `npx wf run list --status RUNNING` lists the same runs as before the upgrade. Timers that came due while nothing ran fire at once, step retries whose backoff ended run, queued runs start, and runs waiting for a signal or a child keep waiting until it comes.

## After the upgrade

- **Api keys.** Every key you had is an `admin` key now. Issue keys with the scope each client needs (`wf keys issue <namespace> --scope read`, `operate` or `admin`, optionally `--expires-in`) and revoke the old ones with `wf keys revoke <keyId>`. Issuing a key no longer creates its namespace: create it first with `wf namespace create`. `wf serve` and `wf dev` still create the namespace of the key they register.
- **Partition maintenance** runs on the elected engine by default. It creates the next days' partitions of `run_events` and drops a day only after retention has purged every run of that day. Without a retention policy nothing is ever dropped. `docs/CONCEPTS.md` explains both.
- **New optional settings.** Payload encryption (`WF_ENCRYPTION_KEYS`), a read replica (`DATABASE_READ_URL`), archives of dropped partitions (`--archive-dir`) and wake-up notifications are all off until you set them. `docs/DEPLOYMENT.md` lists them. Turning encryption on later is safe: payloads written before stay readable.
- **The audit log** starts empty and records admin and operator actions from the upgrade on.

## How this is tested

`test/fixtures/upgrade-v0.1.1/fixture.json` was recorded by the v0.1.1 code itself: `test/fixtures/upgrade-v0.1.1/record.sh` checks out the commit of `chore(release): v0.1.1`, runs the v0.1.1 engine against a fresh schema with the workflows of `test/fixtures/upgrade-v0.1.1/workflows.ts`, stops it with these runs open, and dumps every table:

- a run waiting for a signal after its first step,
- a run sleeping on a durable timer,
- a parent waiting for a child, and the child waiting for a signal,
- a run whose step failed and waits for its retry,
- a run that was started after the engine stopped and is still queued,
- and one run that completed before the upgrade.

The test restores those rows into a schema migrated with the v0.1.1 migrations (it first checks that the shipped files are byte for byte the ones v0.1.1 applied), runs `migrateUp` to the current schema, and then checks that the invariant checker finds nothing, that the v0.1.1 api key authenticates as an `admin` key, that today's engine completes every open run with the expected results while the steps that finished under v0.1.1 are not run again, and that every history, old and new, replays against the workflow code.
