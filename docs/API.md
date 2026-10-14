# HTTP API

The API lives in `packages/api`. `createApiServer(pool, { queueName })` returns a Node `http.Server` (not yet listening) together with the `apiKeys` store and the generated OpenAPI document.

## Authentication and namespaces

Every endpoint under `/v1` needs `Authorization: Bearer <key>`. A key belongs to exactly one namespace and every query filters on it. A run of another namespace answers 404, exactly like a run that does not exist. Missing, unknown and revoked keys answer 401 with `WWW-Authenticate: Bearer realm="dee"`.

Keys are issued from code until an admin surface exists:

```ts
const { key } = await apiKeys.issue("acme", "ci pipeline");
```

The key is shown once; only its sha256 hash is stored.

## Endpoints

| Method | Path                         | Operation      | Success |
| ------ | ---------------------------- | -------------- | ------- |
| POST   | `/v1/runs`                   | `startRun`     | 201/200 |
| GET    | `/v1/runs`                   | `listRuns`     | 200     |
| GET    | `/v1/runs/{runId}`           | `describeRun`  | 200     |
| GET    | `/v1/runs/{runId}/history`   | `getHistory`   | 200     |
| POST   | `/v1/runs/{runId}/signal`    | `signalRun`    | 200     |
| POST   | `/v1/runs/{runId}/cancel`    | `cancelRun`    | 202     |
| POST   | `/v1/runs/{runId}/terminate` | `terminateRun` | 200     |
| GET    | `/openapi.json`              | public         | 200     |

Errors are `{ "error": { "code", "message", "details"? } }`. 400 is a validation failure or a malformed body or cursor, 409 a closed run or a reused idempotency key with a different request, 413 a body over 1 MiB.

## Idempotent start

Send `Idempotency-Key: <1 to 255 characters>` with `POST /v1/runs`. The first call answers 201 and creates the run; any repeat in the same namespace answers 200 with `"created": false` and the same run. Reusing the key with a different workflow type or input answers 409.

## Listing

`GET /v1/runs?status=&workflowType=&limit=&cursor=` returns runs newest first, at most `limit` (1 to 200, default 50). Pass the returned `nextCursor` to get the next page; the last page has none.

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
