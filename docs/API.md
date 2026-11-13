# HTTP API

The API lives in `packages/api`. `createApiServer(pool, { queueName })` returns a Node `http.Server` (not yet listening) together with the `apiKeys` store and the generated OpenAPI document.

## Reference by example

The OpenAPI 3.1 document at `GET /openapi.json` is the full reference and is generated from the same route table the server runs. With `wf dev` running and the key it printed in `$KEY`:

```sh
curl -s -X POST localhost:8080/v1/runs \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: order-1' \
  -d '{"workflowType":"hello","input":{"name":"ada"}}'

curl -s -H "authorization: Bearer $KEY" localhost:8080/v1/runs/$RUN_ID
curl -s -H "authorization: Bearer $KEY" localhost:8080/v1/runs/$RUN_ID/history

curl -s -X POST localhost:8080/v1/runs/$RUN_ID/signal \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"approval","payload":{"approved":true}}'

curl -s -X POST localhost:8080/v1/runs/$RUN_ID/updates/add \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"argument":"apple","updateId":"add-apple-1"}'

curl -s -H "authorization: Bearer $KEY" localhost:8080/v1/runs/$RUN_ID/queries/items

curl -s -X POST localhost:8080/v1/runs/$RUN_ID/cancel \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"reason":"customer asked"}'
```

Probes need no key: `GET /health`, `GET /ready`. `GET /metrics` needs none unless the server is given a `metricsToken`, in which case it needs `Authorization: Bearer <that token>`.

## Authentication and namespaces

Every endpoint under `/v1` needs `Authorization: Bearer <key>`. A key belongs to exactly one namespace and every query filters on it. A run of another namespace answers 404, exactly like a run that does not exist. Missing, unknown and revoked keys answer 401 with `WWW-Authenticate: Bearer realm="dee"`.

Keys are issued from code until an admin surface exists:

```ts
const { key } = await apiKeys.issue("acme", "ci pipeline");
```

The key is shown once; only its sha256 hash is stored.

## Endpoints

| Method | Path                                      | Operation           | Success |
| ------ | ----------------------------------------- | ------------------- | ------- |
| POST   | `/v1/runs`                                | `startRun`          | 201/200 |
| GET    | `/v1/runs`                                | `listRuns`          | 200     |
| GET    | `/v1/runs/{runId}`                        | `describeRun`       | 200     |
| GET    | `/v1/runs/{runId}/history`                | `getHistory`        | 200     |
| POST   | `/v1/runs/{runId}/signal`                 | `signalRun`         | 200     |
| POST   | `/v1/runs/{runId}/updates/{updateName}`   | `updateRun`         | 200/202 |
| GET    | `/v1/runs/{runId}/queries/{queryName}`    | `queryRun`          | 200     |
| POST   | `/v1/runs/{runId}/cancel`                 | `cancelRun`         | 202     |
| POST   | `/v1/runs/{runId}/terminate`              | `terminateRun`      | 200     |
| GET    | `/v1/namespace`                           | `describeNamespace` | 200     |
| GET    | `/v1/dead-letters`                        | `listDeadLetters`   | 200     |
| POST   | `/v1/dead-letters/{deadLetterId}/requeue` | `requeueDeadLetter` | 200     |
| GET    | `/v1/runs/{runId}/stream`                 | not in OpenAPI      | 200     |
| GET    | `/openapi.json`                           | public              | 200     |

Errors are `{ "error": { "code", "message", "details"? } }`. 400 is a validation failure or a malformed body or cursor, a rejected or unknown update or an unknown query, 409 a closed run, a compacted history or a reused idempotency key with a different request, 413 a body over 1 MiB, and 501 an update or query to an API that does not have the workflow's code.

## Updates and queries

An update is a validated, synchronous write into a running workflow that returns a result. The workflow declares it with `defineUpdate(name, { validate, handler })` and registers it with `ctx.setUpdateHandler(definition)`:

```ts
const cart = defineWorkflow("cart", async (ctx) => {
  const items: string[] = [];
  ctx.setQueryHandler("items", () => [...items]);
  ctx.setUpdateHandler(
    defineUpdate<string, number>("add", {
      validate: (sku) => {
        if (items.includes(sku)) throw new Error(`${sku} is in the cart already`);
      },
      handler: (sku) => {
        items.push(sku);
        return items.length;
      },
    }),
  );
  await ctx.waitForSignal("checkout");
  return items;
});
```

`POST /v1/runs/{runId}/updates/{updateName}` takes `{ "argument"?, "updateId"?, "waitMs"? }`. The API takes the run's row lock, replays the history and runs the validator against the state the run is in. A validator that throws answers 400 `update_rejected`, an update name the workflow has not registered answers 400 `unknown_update`, and neither writes an event or a task. Otherwise the API records `update_accepted` and enqueues a workflow task in the same transaction, then waits up to `waitMs` (default 10,000, at most 60,000) for `update_completed`:

- 200 `{ "status": "completed", "updateId", "sequenceNumber", "result" }` when the handler returned.
- 200 `{ "status": "failed", "updateId", "sequenceNumber", "error" }` when the handler threw. The run goes on.
- 202 `{ "status": "accepted", "updateId", "sequenceNumber" }` when the wait ended first, or the run closed before the handler ran. The update stays accepted.

The handler runs inside the workflow at the position of its `update_accepted` event, so every replay applies the same updates in the same order to the same state. Because the row lock is held from validation to commit, concurrent updates are validated one at a time, each against the state the earlier ones left, and their handlers run in the order of their events. A handler may call `ctx.step()`; its result arrives once the step completes. Send the same `updateId` again to retry safely: an id the run accepted before records nothing new and waits for the first call's outcome.

`GET /v1/runs/{runId}/queries/{queryName}?argument=<json>` answers `{ "result" }` from a replay of the history and writes nothing. An unknown query answers 400 `unknown_query`, an `argument` that is not JSON 400 `validation_failed`.

Both replay the workflow, so the API process needs its code: `wf dev` loads the module it runs, `wf serve` needs `--module`. Without it they answer 501 `workflow_not_loaded`. A closed run answers 409 `run_closed` to an update, a compacted history 409 `history_compacted` to both.

## Run stream

`GET /v1/runs/{runId}/stream?after=<sequence number>` is a server sent events stream of one run. It sends a `slice` event with `{ events, status, closed }` for the history after `after` (or the `Last-Event-ID` header, which holds the last sequence number sent), keeps polling the database every `streamPollMs` (default 500 ms) and sends a new `slice` whenever events or the status change. When the run has closed and everything was sent it sends an `end` event and closes. A comment line is sent as a heartbeat every 15 seconds. A namespace can have `maxStreamsPerNamespace` streams open (default 20); one more answers 429 `stream_limit_reached` with `Retry-After: 5`. A stream ends after `maxStreamLifetimeMs` (default 15 minutes) with a `reconnect` event instead of `end`, and the client opens a new one with `Last-Event-ID`. The stream needs the bearer key like every other call, so a browser reads it with `fetch` and not with `EventSource`. A run of another namespace answers 404, a cursor that is not a non negative integer answers 400.

## Dead letters

`GET /v1/dead-letters?limit=&cursor=` lists the namespace's step tasks that used all their attempts, oldest first, one page at a time (the namespace filter, the order and the limit run in SQL). A page holds `limit` entries (default 500, at most 1,000) and carries `nextCursor` when more follow. `POST /v1/dead-letters/{deadLetterId}/requeue` puts one back on its queue and answers `{ "taskId" }`; the step already failed for its workflow, so the task is acknowledged without running the step again (see `docs/CONCEPTS.md`); an unknown id, an id of another namespace and an entry that was requeued already all answer 404.

## Idempotent start

Send `Idempotency-Key: <1 to 255 characters>` with `POST /v1/runs`. The first call answers 201 and creates the run; any repeat in the same namespace answers 200 with `"created": false` and the same run. Reusing the key with a different workflow type or input answers 409.

## Listing

`POST /v1/runs` also accepts `runTimeoutMs` and `executionTimeoutMs` (positive numbers, milliseconds). A run that outlives its run timeout, or whose continue-as-new chain outlives the execution timeout, ends `TIMED_OUT`; a zero or negative value answers 400.

`GET /v1/runs?status=&workflowType=&startedAfter=&startedBefore=&limit=&cursor=` returns runs newest first, at most `limit` (1 to 200, default 50). Pass the returned `nextCursor` to get the next page; the last page has none. `startedAfter` (inclusive) and `startedBefore` (exclusive) are ISO 8601 timestamps.

## Rate limits and quotas

Each namespace can carry a row in `namespace_quotas`, written with `createQuotaStore(pool).set(namespaceId, { ... })`. A limit that is `null`, and a namespace without a row, is not enforced.

| Limit                | Field                    | Checked on                          | Answer                    |
| -------------------- | ------------------------ | ----------------------------------- | ------------------------- |
| Request rate         | `ratePerSecond`, `burst` | every `/v1` request                 | 429 `rate_limited`        |
| Concurrent runs      | `maxConcurrentRuns`      | `startRun` (runs in `RUNNING`)      | 429 `run_quota_exceeded`  |
| Pending tasks        | `maxPendingTasks`        | every write (`PENDING` or `LEASED`) | 429 `task_quota_exceeded` |
| Queue depth (global) | `maxQueueDepth` option   | every write                         | 503 `overloaded`          |

Every refusal carries a `Retry-After` header in whole seconds. For the rate limit it is the time until one token is available; for quotas and queue depth it is `quotaRetryAfterSeconds` (default 5). Limits are per namespace: a namespace that exhausts its bucket or quota does not change the answers other namespaces get. Reads only spend rate limit tokens.

The token bucket lives in the memory of one api process, so with several api processes the effective rate is the sum of their buckets.

## Poison pills

A task whose lease expires without an ack is reclaimed by the janitor. After `poisonThreshold` reclaims (default 3) the task is set to `QUARANTINED` instead of `PENDING` and is never delivered again, so a task that crashes every worker that takes it cannot hold up the queue. `janitor.listQuarantined(namespaceId?)` lists them and `janitor.releaseQuarantined(taskId)` puts one back with a fresh budget. A run whose only open task is quarantined is not recovered as a stalled run.

## Worker backpressure

`createWorker({ pollBudget: createDepthBackpressure({ readDepth, lowWatermark, highWatermark }) })` makes a worker read the queue depth before each poll. An empty queue costs no dequeue, a shallow queue is polled in small batches so work spreads across workers, and a queue at or above the high watermark is drained with every free slot.

## Hardening (day 38)

- **History is paged.** `GET /v1/runs/{runId}/history?limit=&cursor=` returns up to `limit` events (default 500, at most 1,000) and a `nextCursor` while more follow; pass it back as `cursor`. A cursor that is not one the API issued answers 400 `invalid_cursor`. A history that fits one page has no `nextCursor`, so older clients that read `events` keep working for short runs.
- **Unauthenticated requests are throttled per client address.** An address that presents `authThrottle.maxFailures` (default 20) missing or wrong credentials within `authThrottle.windowMs` (default 60 seconds) is answered 429 `too_many_failed_requests` with `Retry-After`, without a database query, until the window ends. The address is the socket's; behind a reverse proxy it is the proxy's, so one bad client can lock out everyone behind the same proxy for a window (`docs/DEFERRED.md`).
- **Errors.** A malformed percent encoding in a path answers 400 `malformed_request`. A 500 is logged at `error` level as `request failed` with the method, the path, the error and the correlation id that the response carries in `x-correlation-id`; the body stays opaque.
- **`/metrics`.** `metricsCacheMs` (default 0, off) serves one rendered scrape for that long; scrapes that arrive while a render runs share it. A failed render is never cached.
- **Workflow types.** With a `workflows` registry in the options, `POST /v1/runs` for a type the registry does not know answers 400 `unknown_workflow_type`. Without a registry any type is accepted, because the process serving the API need not be the one that runs workflows.
- **Idempotent starts.** A repeated `Idempotency-Key` is answered from a lookup before any span or transaction; only a concurrent race on a key reaches the insert, and its `workflow.start` span is ended and marked `dee.start.duplicate`.
- **Headers.** Every JSON, metrics and stream answer carries `x-content-type-options: nosniff`.
