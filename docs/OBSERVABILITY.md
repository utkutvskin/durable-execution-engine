# Observability

Metrics, logs and health probes. Traces are in `docs/TRACING.md`.

## Endpoints

`createApiHandler` serves three public `GET` endpoints that need no api key:

| Endpoint   | Answer                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| `/health`  | `200 {"status":"ok"}` while the process runs. It never touches a dependency.             |
| `/ready`   | `200` when `select 1` succeeds within 2 seconds, otherwise `503` with `checks.database`. |
| `/metrics` | Prometheus text format 0.0.4, or `503 metrics_unavailable` when Postgres cannot be read. |

Use `/health` for the liveness probe and `/ready` for the readiness probe. With Postgres down the process stays live and is taken out of rotation.

## Metrics

All eight are registered by `createEngineMetrics(pool)`. The gauges and the two mirrored counters are read from Postgres on every scrape, so any process reports the whole fleet; only the latency histogram and the reclaim count are per process.

| Metric                       | Type      | Meaning                                                                                   |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `dee_queue_depth`            | gauge     | Visible `PENDING` tasks, by `queue`.                                                      |
| `dee_task_latency_seconds`   | histogram | Seconds from a task becoming visible to the worker settling it, by `queue` and `outcome`. |
| `dee_step_retries_total`     | counter   | Failed step attempts that were scheduled for another try.                                 |
| `dee_timer_lag_seconds`      | gauge     | Age of the oldest overdue pending timer, `0` when none.                                   |
| `dee_active_workers`         | gauge     | Distinct workers that hold a task lease.                                                  |
| `dee_runs`                   | gauge     | Runs by `status`; every status is present, with `0` when empty.                           |
| `dee_tasks_quarantined`      | gauge     | Poison tasks parked by the janitor, by `queue`.                                           |
| `dee_leases_reclaimed_total` | counter   | Leases the janitor took back in this process (needs the `recovery` option).               |

Feed the histogram from a worker:

```ts
const metrics = createEngineMetrics(pool, { recovery });
createWorker({
  queue,
  queueName,
  handler,
  onTaskSettled: ({ task, outcome, latencySeconds }) =>
    metrics.observeTaskLatency(task.queueName, outcome, latencySeconds),
});
```

Because a worker process is not the API process, expose its registry with `metrics.render()` on a port of its own, or pass the same `EngineMetrics` to `createApiHandler` in a single-process setup.

## Logs

`createLogger()` writes one json object per line: `time`, `level`, `message`, bound fields, call fields and, inside `withCorrelationId`, `correlationId`. Errors are serialized with name, message and stack. The api handler reads `x-correlation-id` (1 to 128 characters of letters, digits and `-_.:`, otherwise a new uuid), returns it in the response header and logs `request completed` with method, path, status and duration under it.

## Dashboard

`docs/grafana/dee-overview.json` is an importable Grafana dashboard with a panel for each metric. Import it and choose the Prometheus data source. A test checks that it queries only metrics the engine exports.
