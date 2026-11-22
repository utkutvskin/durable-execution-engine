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

## Sticky routing with three workers

`pnpm run bench:sticky` starts three `startEngine` instances on one fresh schema, runs 60 workflows of 4 sequential steps through them and counts, per decision, whether it advanced a cached live session or replayed the history from the top. The first decision of a run cannot hit the cache, so the hit rate is taken over the decisions after it (`BENCH_ENGINES`, `BENCH_RUNS` and `BENCH_STICKY=off` change the setup).

| Sticky routing | Engines | Decisions after the first | Cache hits | Hit rate |
| -------------- | ------: | ------------------------: | ---------: | -------: |
| on             |       3 |                       240 |        240 |  100.0 % |
| off            |       3 |                       240 |        139 |   57.9 % |

With routing on, an engine claims a run after every decision that leaves it open and the other engines skip that run's workflow tasks; the decisions were still shared between the engines (110, 95 and 95). With routing off, a run's tasks land on any engine and a hit needs the same engine twice in a row. The test `sticky-bench.integration.test.ts` asserts a hit rate above 80 percent with routing on and below 85 percent with routing off. The figures come from one run on the machine of the other tables; the "off" figure varies from run to run.

## Visibility queries over 100,000 runs

```sh
DATABASE_URL=postgres://dee:dee@localhost:5432/dee pnpm run bench:visibility
```

seeds 100,000 runs of one namespace (`BENCH_VISIBILITY_RUNS`), one started per second going back from now, each with the search attributes `customerId` (997 customers), `amount` (0 to 999), `region` and `vip` (one run in 50); one run in 20 failed and one in 20 is open. It sends the statement `GET /v1/runs?query=...` sends (the namespace condition, the compiled query, the newest first page of 50 plus one) and prints its `EXPLAIN (ANALYZE)` plan and the median and slowest wall time of 20 executions (`BENCH_VISIBILITY_ROUNDS`), measured from the Node process, on the machine of the other tables. Migration `0024_search_attributes` adds the GIN index `workflow_runs_search_attributes_idx (search_attributes jsonb_path_ops)` and `workflow_runs_namespace_status_started_idx (namespace_id, status, started_at desc, id desc)`; `workflow_runs_namespace_started_idx` came with migration 0012.

| Query                                                                   | Rows | Execution (ms) | Median wall (ms) | Slowest wall (ms) | Plan                                                  |
| ----------------------------------------------------------------------- | ---: | -------------: | ---------------: | ----------------: | ----------------------------------------------------- |
| `status = 'FAILED' and customerId = 'c-1' and startedAt > '<12 h ago>'` |    2 |           4.78 |             4.18 |              8.47 | BitmapAnd of the status index and the GIN index, Sort |
| `customerId = 'c-17'`                                                   |   51 |           4.31 |             5.70 |              6.35 | GIN Bitmap Index Scan, Sort                           |
| `customerId = 'nobody'`                                                 |    0 |           4.75 |             4.74 |              5.25 | GIN Bitmap Index Scan                                 |
| `status = 'FAILED' and amount > 900`                                    |   51 |           1.38 |             1.76 |              2.34 | Index Scan on the status index, filter                |
| `vip = true or customerId = 'c-3'`                                      |   51 |           2.39 |             3.04 |              3.40 | Index Scan on the namespace index, filter             |
| `amount > 998`                                                          |   51 |          62.16 |            35.62 |             66.01 | Index Scan on the namespace index, filter             |

Every query answers in under 100 ms, the example of the backlog in under 10 ms. The plan of that example:

```
Limit (actual time=4.816..4.818 rows=2 loops=1)
  ->  Sort (actual time=4.815..4.816 rows=2 loops=1)
        Sort Key: started_at DESC, id DESC
        Sort Method: quicksort  Memory: 25kB
        ->  Bitmap Heap Scan on workflow_runs (actual time=4.805..4.809 rows=2 loops=1)
              Recheck Cond: ((namespace_id = '80aab532-...'::uuid) AND (status = 'FAILED'::text) AND (started_at > '2026-11-14 21:34:35.483+00'::timestamp with time zone) AND (search_attributes @> '{"customerId": "c-1"}'::jsonb))
              Heap Blocks: exact=2
              ->  BitmapAnd (actual time=4.792..4.793 rows=0 loops=1)
                    ->  Bitmap Index Scan on workflow_runs_namespace_status_started_idx (actual time=0.364..0.364 rows=2159 loops=1)
                          Index Cond: ((namespace_id = '80aab532-...'::uuid) AND (status = 'FAILED'::text) AND (started_at > '2026-11-14 21:34:35.483+00'::timestamp with time zone))
                    ->  Bitmap Index Scan on workflow_runs_search_attributes_idx (actual time=4.367..4.367 rows=101 loops=1)
                          Index Cond: (search_attributes @> '{"customerId": "c-1"}'::jsonb)
Planning Time: 0.153 ms
Execution Time: 4.844 ms
```

and of the slowest, a range on an attribute no index covers:

```
Limit (actual time=0.576..33.265 rows=51 loops=1)
  ->  Index Scan using workflow_runs_namespace_started_idx on workflow_runs (actual time=0.576..33.254 rows=51 loops=1)
        Index Cond: (namespace_id = '80aab532-...'::uuid)
        Filter: (CASE WHEN (jsonb_typeof((search_attributes -> 'amount'::text)) = 'number'::text) THEN ((search_attributes ->> 'amount'::text))::numeric ELSE NULL::numeric END > '998'::numeric)
        Rows Removed by Filter: 50806
Planning Time: 0.140 ms
Execution Time: 33.291 ms
```

Equality on an attribute (`@>`) is served by the GIN index; an ordering on an attribute is not indexed and is evaluated while walking the namespace or status index newest first, so its cost grows with how many runs it has to skip before it fills a page: `amount > 998` matches one run in 1,000 and reads about 51,000. A query that matches nothing with only such a filter reads the whole namespace; that is the case to watch, and typed expression indexes per attribute are the fix (`docs/DEFERRED.md`). The test `visibility-queries.integration.test.ts` (20,000 runs) fails when any of these queries reads `workflow_runs` sequentially, when attribute equality stops using the GIN index or the range stops using the status index.

## Fewer statements per run

Day 28 left the saturated system bound by the number of statements per run. By day 52 the benchmark's three-step run cost 55 statements: the run row, an append in its own transaction (`begin`, the sequence read, the insert, `commit`) and the task; the pause read and the dequeue; eight per step result (`begin`, the run lock, the result check, the result insert, the sequence read twice, the event insert, `commit`); the history read; fifteen to record and close the run; six to refresh the projection, and the ack. The hot paths are now SQL functions called as one statement each (migration 0030, ADR-0063), and the same run costs 14:

| Part of the run                             | Before |  After |
| ------------------------------------------- | -----: | -----: |
| Start (run row, events, task)               |      6 |      3 |
| Pause read and dequeue                      |      2 |      2 |
| Three step results                          |     24 |      3 |
| History read                                |      1 |      1 |
| Record `run_completed` and close the run    |     15 |      4 |
| Refresh the projection (already up to date) |      6 |      1 |
| Ack                                         |      1 |      1 |
| **Total**                                   | **55** | **14** |

`packages/worker/src/bench/statements.integration.test.ts` runs exactly that run through the harness's own `startBenchRun` and `completeBenchRun` on a pool that records every statement and fails above 15. A second test counts a three-step workflow on the real engine, started through the run service, with its polls left out: 150 statements before and 86 after, including one tick of the engine's loops and its shutdown; it fails above 90. What the engine still spends is in `docs/DEFERRED.md`.

Each figure is the median of 5 runs of the default benchmark (400 runs of 3 steps), measured on the same machine before and after, with nothing else running:

| Measure                     |      Before |      After |     Change |
| --------------------------- | ----------: | ---------: | ---------: |
| Runs started per second     |         964 |      1,254 |       +30% |
| Steps completed per second  |         592 |      1,070 |       +81% |
| Events appended per second  |      29,412 |     57,342 |       +95% |
| Start a run, p50 / p99 (ms) | 13.6 / 74.5 | 9.7 / 70.2 | -29% / -6% |
| Run end to end p50 (ms)     |         864 |        463 |       -46% |
| Run end to end p95 (ms)     |       1,332 |        592 |       -56% |
| Run end to end p99 (ms)     |       1,372 |        602 |       -56% |
| Append 10 events, p50 (ms)  |         4.7 |        2.6 |       -45% |
| Append 10 events, p95 (ms)  |         8.1 |        4.8 |       -41% |
| Append 10 events, p99 (ms)  |        16.0 |        6.1 |       -62% |

Over the 5 runs of each side the steps per second ranged from 554 to 663 before and from 995 to 1,130 after, so the ranges do not overlap. The append rows improved because an append is one statement instead of four, the end-to-end rows because a run costs a quarter of the statements. The start rows improved less: the benchmark's start still writes the run row, its events and its task in three statements, while the engine's own start (`insert_run`) is one.

Three more changes of the same day are not exercised by this benchmark, which records results directly and never heartbeats: a run has at most one pending workflow task, so a fan-out of step results causes one decision instead of one per result (migration 0031); a worker sends the acks and the heartbeats of one event loop turn as one statement each; and a heartbeat writes `lease_extended_until`, a column no index covers, so it is a HOT update (migration 0032; `lease-heartbeat.test.ts` reads `n_tup_hot_upd` and sees 10 HOT updates for 10 heartbeats and none for 10 updates of `visible_at`). The same migration gives `tasks`, `timers` and `run_stickiness` a lower `fillfactor`, so a page has room for the new version of a row, and autovacuum thresholds that vacuum these small, hot tables after a few hundred dead rows instead of after a fifth of the table.

## Wake-ups on an idle queue

An idle worker waits out its empty-poll backoff before it looks again: the engine polls after 50 ms, doubles the wait after every empty poll and stops at 500 ms. A run started on an idle engine waits for two of those polls, one for its first workflow task and one for the step task that decision enqueues. With `wakeups: true` (ADR-0064) the engine listens for the notification the `tasks` insert trigger sends when the inserting session has `dee.notify_wakeups` on, and its workers poll at once; a decision that recorded events also wakes the engine's own step pool.

`pnpm run bench:wakeup` starts one-step runs through the run service on an engine with the default poll settings, one at a time, waits 1.5 s before each start so the workers have backed off to 500 ms, and measures from the start call to the step handler starting. 40 samples per side (`BENCH_WAKEUP_SAMPLES`, `BENCH_WAKEUP_IDLE_MS`), same machine:

| Wake-ups      | p50 (ms) | p95 (ms) | Max (ms) |
| ------------- | -------: | -------: | -------: |
| off (polling) |    519.8 |    715.9 |    792.6 |
| on            |     14.3 |     22.3 |     31.8 |

A second run gave 723.1 / 729.5 / 793.0 without and 13.7 / 19.2 / 26.0 with wake-ups. What remains is the work itself: about 2 ms for the start, 6 ms to lease and decide the workflow task, and 5 to 8 ms to lease the step task and call its handler. `packages/worker/src/bench/wakeup-latency.integration.test.ts` measures 20 samples with wake-ups on an engine polling every 500 ms and fails when the p50 is 20 ms or more; a second test checks that the same engine without wake-ups is slower than that.

## 10,000 timers due at once

The timer scheduler fired one timer per transaction, about six statements each. It now fires a batch of due timers (up to `batchSize`, default 100) in one transaction of eight statements: the due timers, the runs with their current sequence numbers, one insert for every `timer_fired` event, one update for the timers, one insert for the workflow tasks and their ids. A run timeout timer still gets a transaction of its own and ends a batch. `packages/core/src/timers/batched-timers.test.ts` seeds 10,000 runs with a timer each, all due, lets three schedulers race over them with batches of 250, and checks that every timer was fired once, that every run has exactly one `timer_fired` event and one workflow task, and that a batch of 100 costs at most 8 statements.

## What to try next

- The engine's own three-step run still costs 86 statements, most of them reads before a step and markers after a decision. Folding those (`docs/DEFERRED.md`, day 53) is the next lever for the engine, where this benchmark's path is down to 14.
- The numbers here have one process and a local database. A run with workers on separate machines and a remote Postgres would show whether the round trip count or the database becomes the limit first.
