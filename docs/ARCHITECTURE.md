# Architecture

The engine is a set of small libraries and processes around one PostgreSQL database. Postgres is the only stateful part: the event log, the task queue, the timers and the schedules all live in it. Every other process can be stopped and replaced at any time.

## The packages

```mermaid
flowchart LR
  cli["packages/cli<br/>wf dev, wf serve, wf worker,<br/>wf run, wf migrate"] --> api
  cli --> worker
  ui["apps/ui<br/>run explorer"] --> api
  api["packages/api<br/>HTTP, scoped keys, quotas,<br/>audit, codec"] --> core
  worker["packages/worker<br/>poll loop, engine, loops"] --> core
  core["packages/core<br/>event store, replay, queue,<br/>timers, schedules, retries,<br/>retention, reset, batches"] --> pg[("PostgreSQL 16")]
  api -. reads .-> replica[("read replica<br/>optional")]
  examples["examples/*<br/>workflows and steps"] --> core
```

| Package           | What lives there                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`   | The workflow DSL (`defineWorkflow`, `defineStep`, `ctx`), the event store, the decision loop that replays history, the task queue, timers, schedules, retries, quotas, rate limits, the janitor, retention and partitions, the payload codec, reset and batches.   |
| `packages/worker` | A worker (poll loop, lease heartbeat, graceful shutdown), the engine runtime `startEngine` with its decision and step pools, leader election, and the timer, schedule, janitor, compaction, retention and partition loops. Also the chaos and benchmark harnesses. |
| `packages/api`    | A `node:http` layer over one route table: runs, signals, updates, queries, events, visibility, history, dead letters, quarantine, admin, audit, the codec endpoint, the run stream, health, metrics and the generated OpenAPI document.                            |
| `apps/ui`         | A run explorer written as typed browser modules and served from the API's origin.                                                                                                                                                                                  |
| `packages/cli`    | `wf`: `dev`, `serve`, `worker`, `migrate`, `run ...`, `schedule`, `pause`, `dlq`, `quarantine`, `reset`, `fork`, `batch`, the admin commands, `history`, `replay` and `example`.                                                                                   |
| `examples`        | `hello`, `payment-saga`, `etl-pipeline` and `outbox`.                                                                                                                                                                                                              |

## The data model

```mermaid
erDiagram
  namespaces ||--o{ workflow_runs : owns
  namespaces ||--o{ api_keys : issues
  namespaces ||--o{ audit_log : records
  workflow_runs ||--o{ run_events : "append-only log"
  workflow_runs ||--o{ tasks : "has open work"
  workflow_runs ||--o{ task_history : "finished work"
  workflow_runs ||--o{ timers : sleeps
  workflow_runs ||--o{ step_results : "one per step attempt key"
  workflow_runs ||--o{ step_attempts : "retry bookkeeping"
  workflow_runs ||--o| run_snapshots : "after compaction"
  tasks ||--o| dead_letters : "retries exhausted"
  schedules ||--o{ schedule_triggers : "ledger"
  schedules ||--o{ workflow_runs : starts
  workflow_runs ||--o| workflow_runs : "reset from"
  batch_operations ||--o{ batch_operation_targets : snapshots
```

- `run_events` is the source of truth. A row is `(run_id, sequence_number, event_type, payload)` and the pair `(run_id, sequence_number)` is unique, which is what makes appends safe under concurrency. The table is range partitioned by `run_created_at`, the creation time of the event's run, one partition per UTC day, so all events of a run share a partition; `run_event_partitions` records each partition's range, its archive and when it was dropped. The events of runs created before migration 0037 live in `run_events_legacy`, and `run_events_default` catches a day whose partition does not exist yet.
- `workflow_runs` is a projection: the status, the result and the timestamps are a pure fold over the events and can be rebuilt from them.
- `tasks` is the queue. A task is `PENDING`, `LEASED`, `COMPLETED` or `QUARANTINED`. A lease has a token and an expiry. Completed tasks move to the append-only `task_history` after a short grace period, and `all_tasks` reads both.
- `step_results` and `workflow_task_results` are the idempotency ledgers: a result is written once per logical key, in the same transaction as the event it produces.
- `timers`, `schedules` and `schedule_triggers` make time durable: a timer fires from the database, never from process memory.
- `namespace_retention` holds how long a namespace's closed runs keep their execution data; the retention sweep purges it afterwards and marks the run with `purged_at`.
- `api_keys` carry a scope (`read`, `operate`, `admin`), an expiry and their last use; `audit_log` is the append-only record of admin and operator actions.
- `batch_operations` and `batch_operation_targets` hold a batch and the snapshot of runs it works through; a reset run points at its source with `reset_from_run_id`.

Schema changes are SQL migration pairs in `packages/core/migrations`, applied by `wf migrate` or `pnpm run migrate:up`.

## The life of a run

```mermaid
sequenceDiagram
  participant C as client
  participant A as api
  participant DB as postgres
  participant W as engine worker
  participant S as step handler
  C->>A: POST /v1/runs
  A->>DB: run row + run_started + WORKFLOW_TASK (one transaction)
  W->>DB: lease WORKFLOW_TASK
  W->>DB: read history
  Note over W: replay the workflow function against the history
  W->>DB: append step_scheduled + create STEP_TASK
  W->>DB: lease STEP_TASK
  W->>S: run the step (retry policy, timeout)
  S-->>W: result
  W->>DB: step result + step_completed + WORKFLOW_TASK (one transaction)
  W->>DB: lease WORKFLOW_TASK, replay, decide
  W->>DB: run_completed, projection updated, parent notified
  C->>A: GET /v1/runs/{id}
  A-->>C: COMPLETED + result
```

1. A client starts a run. The API writes the run row, the first event and a workflow task in one transaction.
2. A worker leases the workflow task, reads the history and runs the workflow function again from the top. Calls that already have a recorded result return it immediately. The first call without a result becomes a command: schedule a step, start a timer, start a child, complete the run.
3. The commands become events. A scheduled step becomes a step task.
4. A worker runs the step through the retry processor. The result, the event and the next workflow task are committed together.
5. The loop repeats until the workflow function returns or throws, which appends `run_completed` or `run_failed` and updates the projection.

A worker holds a task only while its lease is alive. It renews the lease on a heartbeat. If the worker dies, the lease expires and the janitor makes the task visible again; another worker takes it and the replay produces the same decision.

## Background loops

`startEngine` runs these next to the task consumers. Only the engine that holds a session advisory lock runs them (ADR-0064); when it stops or loses its connection, another engine is elected and takes over. Each loop is also safe to run in many processes at once.

| Loop       | Job                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| timer      | Fires due timers in due-time order, in batches, and enqueues the workflow task that resumes each run.                    |
| schedule   | Starts runs for cron triggers that came due, including the ones missed while nothing was running, by the overlap policy. |
| janitor    | Reclaims expired leases, quarantines poison tasks, recovers stalled runs by enqueueing a new workflow task.              |
| compaction | Snapshots and trims the history of long runs, when configured.                                                           |
| retention  | Moves finished tasks to `task_history` and purges the closed runs whose namespace retention ran out.                     |
| partitions | Creates the coming days' `run_events` partitions, and archives and drops a day once every run of it is purged.           |

## Failure model

| Failure                              | What happens                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| A worker is killed mid step          | The lease expires, the janitor reclaims the task, another worker runs the step again. Steps must be safe to run twice.    |
| A task is delivered twice            | Results are keyed; the second writer finds the first result and records nothing.                                          |
| Two writers extend one history       | The unique sequence number rejects one with a `ConcurrencyError`; its task is redelivered and replays the longer history. |
| The database connection drops        | The transaction rolls back as a whole; the task is redelivered.                                                           |
| The clock moves                      | Timers use a monotonic high water mark, so a clock stepped back never fires a timer early or twice.                       |
| The code changes under a running run | Replay compares each call with the recorded event and raises `NonDeterminismError`; see `docs/VERSIONING.md`.             |

`docs/CHAOS_REPORT.md` lists the fault scenarios the test suite injects, against the recorder and against `startEngine` (17 scenario runs), and the six invariants it checks after each.

## Upgrades

The history is the source of truth, so a migration never needs to understand a run to keep it: it changes the tables around the events, and the next decision replays the events as they were written. Migrations are SQL pairs applied in order, each in its own transaction, under an advisory lock. Within a minor version, old and new processes can run side by side during a rolling restart; from 0.1 to 0.2 they cannot, because `run_events` gained a mandatory partition key. `docs/UPGRADING.md` gives the steps, and `test/upgrade/upgrade-from-v0.1.1.test.ts` proves them on a database the v0.1.1 engine left with open runs.

## What the engine does not do

The engine is one Postgres deep. It does not shard the event log, run on a storage engine of its own, speak gRPC or span regions; `docs/OUT_OF_SCOPE.md` lists these and `docs/ROADMAP.md` says what comes next. Throughput on one node is in `docs/BENCHMARKS.md`.
