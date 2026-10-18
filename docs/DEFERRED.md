# Deferred

Work that a day's scope named and that could not be finished or proven in its session. Each entry says what is missing and why.

## Jaeger check of the span tree (day 24)

The "Done when" item for day 24 asks for a run with a child workflow to appear in Jaeger as one unbroken span tree. The compose file now starts Jaeger (`docker compose up -d jaeger`), but the session that built the day had no Docker daemon, so the tree was verified against an in-memory exporter instead: one trace id, one root, every parent present, in `packages/core/src/observability/run-tracing.test.ts`. The OTLP exporter and the Jaeger UI were not exercised. To close this: run a traced parent and child workflow with `createTracingProvider({ otlpEndpoint })` against the compose Jaeger and confirm the tree in the UI.

## Chaos faults that need control of the server (day 27)

The chaos suite injects every fault in front of Postgres (see ADR-0037). Not covered: restarting the Postgres server under load, a real fsync stall or a full disk, and packet loss between hosts. To close this: run the same scenarios against a Postgres in compose and restart or throttle that container from the harness.

## Broken connections returned to the pool (day 27)

Code that takes a client with `pool.connect()` releases it with `client.release()`. When the connection died while the client was held, the client goes back into the pool and the next statement on it fails once before pg drops it. The engine survives this because a failed task is redelivered, but a statement fails that did not need to. To close this: release with `client.release(error)` in the catch paths of the recorder, the timer scheduler, the schedule manager and the projection store, or evict a client in `createPool` when it reports an error.
