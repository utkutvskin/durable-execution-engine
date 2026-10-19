# Benchmarks

Baseline figures for a single node, the bottlenecks they exposed, and the before and after numbers of the fixes. Everything here is reproduced by two commands:

```sh
DATABASE_URL=postgres://dee:dee@localhost:5432/dee pnpm run bench
DATABASE_URL=postgres://dee:dee@localhost:5432/dee pnpm run bench:explain
```

`bench` prints the throughput and latency tables. Every setting can be overridden through an environment variable (`BENCH_RUNS`, `BENCH_STEPS_PER_RUN`, `BENCH_WORKERS`, `BENCH_WORKER_CONCURRENCY`, `BENCH_POOL_SIZE`, `BENCH_START_CONCURRENCY`, `BENCH_APPEND_BATCH_SIZE`, `BENCH_APPEND_RUNS`, `BENCH_APPEND_ROUNDS`). `bench:explain` seeds 100,000 runs (`BENCH_EXPLAIN_RUNS`) and prints the `EXPLAIN (ANALYZE)` summary of every hot query. The harness lives in `packages/worker/src/bench/`.

## Environment

One machine runs everything: the benchmark process (one Node 22 process holding the starters and the workers), PostgreSQL 16 with its default configuration, 4 cores, no network between the two. The numbers show the engine's own cost per operation, not what a deployment with a remote database would see: every query there adds a network round trip, which makes the round trip counts below matter more.

## What is measured

- **Runs started per second.** A start inserts the run row, appends `run_started` plus one `step_scheduled` per step, and enqueues a step task. 16 starters in parallel, no worker consuming.
- **Steps completed per second and end-to-end latency.** Starters and 2 workers (8 tasks in flight each) run together. A worker records each step result, records the `run_completed` workflow task result and refreshes the projection. The latency of a run is the time from the start call to the end of its handler. The starters submit as fast as they can, so the queue is always full and the latency includes the wait in the queue: it is the latency of a saturated system, and p50 is roughly the queue length divided by the throughput.
- **Events appended per second.** 16 runs append batches of 10 events, 100 batches each, through `EventStore.append`.

Each figure below is the median of 5 runs of 400 runs with 3 steps each (1,200 steps).

## Baseline and after

| Measure                     |      Before |       After |       Change |
| --------------------------- | ----------: | ----------: | -----------: |
| Runs started per second     |         859 |       1,019 |         +19% |
| Events appended per second  |      16,382 |      29,149 |         +78% |
| Append 10 events, p50 (ms)  |         8.9 |         5.2 |         -42% |
| Append 10 events, p95 (ms)  |        15.7 |         8.3 |         -47% |
| Append 10 events, p99 (ms)  |        21.7 |        10.3 |         -53% |
| Start a run, p50 / p99 (ms) | 15.7 / 82.6 | 13.6 / 73.3 |  -13% / -11% |
| Steps completed per second  |         728 |         696 | within noise |
| Run end to end p50 (ms)     |         710 |         747 | within noise |
| Run end to end p95 (ms)     |         935 |       1,057 | within noise |
| Run end to end p99 (ms)     |         960 |       1,070 | within noise |

The end-to-end rows did not improve. Over the 5 runs of each side the steps per second ranged from 679 to 797 before and from 643 to 705 after, so a small loss from the extra index maintenance on `tasks` cannot be ruled out. The saturated system is limited by the number of statements per run, not by the statements themselves (see the first bottleneck).

## Bottlenecks

### 1. One round trip per event

`appendEventsOnClient` inserted events one statement at a time, so an append of N events cost N inserts plus the sequence check. `pg_stat_statements` showed the single-event `insert into run_events` as the most called statement of a benchmark run (8,000 calls) and a CPU profile of the benchmark process put 906 ms of 3,080 ms in `writev`, the socket write of a query: the process is bound by the number of statements, not by the work Postgres does for them (Postgres spent 0.07 ms on a typical insert).

**Fix.** The events of one append are written with one `insert ... select from unnest(...)`. The sequence numbers are still assigned by the caller's `expectedSeq` and the unique constraint on `(run_id, sequence_number)` is still the final guard, so the optimistic concurrency rules and the `ConcurrencyError` behavior are unchanged. Tests assert that 25 events cost one insert statement, that 300 events with quotes and backslashes in their payloads come back in order and unchanged, and that a second batch continues without a gap.

**Result.** Appending batches of 10: 16.4k to 29.1k events per second, p50 8.9 ms to 5.2 ms. Starting a run (4 events): 859 to 1,019 runs per second. A run with a single event per append gains nothing, which is why the end-to-end workload, whose appends are single events, did not move.

### 2. The dequeue sorted every open task

`EXPLAIN ANALYZE` on 100,000 seeded runs showed the dequeue doing a bitmap scan over all visible `PENDING` and `LEASED` tasks of the queue and then a sort, because the index `tasks_queue_dequeue_idx (queue_name, visible_at)` does not cover the `order by visible_at, created_at, id`. The cost grows with the queue depth, at the moment the queue is deepest.

**Fix.** Migration `0016_hot_query_indexes` replaces that index with `tasks_queue_order_idx (queue_name, visible_at, created_at, id)` with the same partial predicate. The plan becomes an ordered index scan that stops at the `limit`.

**Result.** The dequeue with a queue of 3,300 open tasks: 4.96 ms to 0.05 ms (median of 3 plans).

### 3. The stalled run scan read every run

The janitor's stalled run query filters on `status = 'RUNNING'`, and no index covered that, so every sweep sequentially scanned `workflow_runs` (all runs ever started, 100,000 in the seed) and then, because the planner had no cheap way to look up a run's open tasks, sequentially scanned `tasks` as well.

**Fix.** The same migration adds `workflow_runs_open_idx (created_at, id) where status = 'RUNNING'` and `tasks_open_run_idx (run_id) where state in ('PENDING', 'LEASED', 'QUARANTINED')`. Both are partial, so they hold only the open runs and the open tasks and stay small however much history accumulates.

**Result.** The stalled run query over 5,000 open runs of 100,000: 245 ms to 40 to 78 ms (median of 3 plans before and after, the after plans varied between runs). What remains is the per-run `max(created_at)` over the run's events, 5,000 index lookups.

## Index review

`EXPLAIN (ANALYZE)` over the seeded data, after the migration. `pnpm run bench:explain` regenerates it. A test (`hot-queries.integration.test.ts`) fails when the dequeue sorts, when the stalled run scan reads `workflow_runs`, `tasks` or `run_events` sequentially, or when any other hot query below falls back to a sequential scan.

| Query                        | Before (ms) |  After (ms) | Plan after                                          |
| ---------------------------- | ----------: | ----------: | --------------------------------------------------- |
| dequeue                      |        4.96 |        0.05 | index scan in order, no sort                        |
| stalled runs                 |         245 |     40 - 78 | open run index, open task index                     |
| reclaim expired leases       | 2.31 - 5.02 | 2.69 - 2.90 | index scan on `tasks_leased_expiry_idx`             |
| due timers                   |        0.03 |        0.03 | index scan on `timers_due_idx`                      |
| queue depth gauge            |        2.27 |        2.29 | bitmap scan on the dequeue index                    |
| active workers gauge         | 1.30 - 2.08 | 1.30 - 1.45 | index scan on the leased index                      |
| list runs                    |        0.03 |        0.03 | index scan on `workflow_runs_namespace_started_idx` |
| read history, sequence check |        0.04 |        0.04 | `run_events_run_id_sequence_number_key`             |

Reviewed and left alone: the history read and the sequence check are index lookups of well under a millisecond. The reclaim query and the two gauges touch every leased or pending task by design and cost 1 to 3 ms with 3,300 open tasks.

## Tuning the pool and the batch size

The worker takes every free slot on each poll, so its dequeue batch size is its concurrency. Over 1 to 4 workers, 4 to 32 tasks in flight each and pools of 10 to 64 connections on this machine, the end-to-end throughput stayed between 580 and 760 steps per second with no setting clearly ahead: the benchmark process is limited by the statements it issues (the profile above), and a larger pool or more concurrency only adds waiting. The defaults stay: the pool of the benchmark is 20 for 16 tasks in flight, which leaves headroom for the heartbeat, the starters and the projection refresh. With the database on another host the balance changes, since a task waiting on a round trip leaves its connection idle; raise concurrency before the pool size, and keep the pool at least as large as the tasks in flight plus a few.

## What to try next

- `recordStepResult` reads the current sequence twice (once itself, once inside `appendEventsOnClient`). A variant that appends at the tail in one call saves one statement per step, about 5% of the statements of a run.
- A run that starts and completes three steps costs about 47 statements, a quarter of them `begin` and `commit`. Folding the lock, the existing-result check and the insert of `recordWorkflowTaskResult` into fewer statements is the largest remaining lever for the end-to-end figures.
- The numbers here have one process and a local database. A run with workers on separate machines and a remote Postgres would show whether the round trip count or the database becomes the limit first.
