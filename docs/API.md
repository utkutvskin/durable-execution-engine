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

Every endpoint under `/v1` needs `Authorization: Bearer <key>`. A key belongs to exactly one namespace and every query filters on it. A run of another namespace answers 404, exactly like a run that does not exist. Missing, unknown, revoked and expired keys answer 401 with `WWW-Authenticate: Bearer realm="dee"`.

Every key has a scope:

| Scope     | May call                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `read`    | every `GET` of its namespace, the run stream and queries                                                                     |
| `operate` | also every `POST` of its namespace: starts, signals, updates, events, cancel, terminate, pauses, schedules, requeue, release |
| `admin`   | also everything under `/v1/admin`, which acts on any namespace                                                               |

A key whose scope is too weak answers 403 `forbidden` with a message that names the scope the operation needs, before its body is read. The OpenAPI document lists the scope of every operation as `x-required-scope`. Keys issued before scopes existed are `admin` keys. A key can carry an expiry (`expiresAt`) and records `lastUsedAt`, written at most once a minute per key.

Namespaces and keys are created through the admin endpoints (`wf namespace create`, `wf keys issue`, see `docs/CLI.md`) or from code. Issuing a key never creates its namespace: a missing one answers 404 `namespace_not_found`.

```ts
await apiKeys.createNamespace("acme");
const { key } = await apiKeys.issue("acme", { scope: "operate", label: "ci pipeline" });
```

The key is shown once; only its sha256 hash is stored.

## Endpoints

| Method | Path                                      | Operation                | Success |
| ------ | ----------------------------------------- | ------------------------ | ------- |
| POST   | `/v1/runs`                                | `startRun`               | 201/200 |
| GET    | `/v1/runs`                                | `listRuns`               | 200     |
| GET    | `/v1/runs/{runId}`                        | `describeRun`            | 200     |
| GET    | `/v1/runs/{runId}/history`                | `getHistory`             | 200     |
| POST   | `/v1/runs/{runId}/signal`                 | `signalRun`              | 200     |
| POST   | `/v1/signal-with-start`                   | `signalWithStart`        | 201/200 |
| POST   | `/v1/events`                              | `sendEvent`              | 202     |
| POST   | `/v1/event-triggers`                      | `createEventTrigger`     | 201     |
| GET    | `/v1/event-triggers`                      | `listEventTriggers`      | 200     |
| POST   | `/v1/runs/{runId}/updates/{updateName}`   | `updateRun`              | 200/202 |
| GET    | `/v1/runs/{runId}/queries/{queryName}`    | `queryRun`               | 200     |
| POST   | `/v1/runs/{runId}/cancel`                 | `cancelRun`              | 202     |
| POST   | `/v1/runs/{runId}/terminate`              | `terminateRun`           | 200     |
| GET    | `/v1/runs/{runId}/reset-points`           | `listResetPoints`        | 200     |
| POST   | `/v1/runs/{runId}/reset`                  | `resetRun`               | 201     |
| POST   | `/v1/runs/{runId}/fork`                   | `forkRun`                | 201     |
| POST   | `/v1/batches`                             | `startBatch`             | 201     |
| GET    | `/v1/batches`                             | `listBatches`            | 200     |
| GET    | `/v1/batches/{batchId}`                   | `getBatch`               | 200     |
| GET    | `/v1/batches/{batchId}/targets`           | `listBatchTargets`       | 200     |
| GET    | `/v1/namespace`                           | `describeNamespace`      | 200     |
| GET    | `/v1/dead-letters`                        | `listDeadLetters`        | 200     |
| POST   | `/v1/dead-letters/{deadLetterId}/requeue` | `requeueDeadLetter`      | 200     |
| POST   | `/v1/pauses`                              | `pause`                  | 201/200 |
| POST   | `/v1/pauses/resume`                       | `resume`                 | 200     |
| GET    | `/v1/pauses`                              | `listPauses`             | 200     |
| POST   | `/v1/schedules`                           | `createSchedule`         | 201     |
| GET    | `/v1/schedules`                           | `listSchedules`          | 200     |
| GET    | `/v1/schedules/{scheduleId}`              | `getSchedule`            | 200     |
| GET    | `/v1/schedules/{scheduleId}/triggers`     | `listScheduleTriggers`   | 200     |
| POST   | `/v1/schedules/{scheduleId}/pause`        | `pauseSchedule`          | 200     |
| POST   | `/v1/schedules/{scheduleId}/resume`       | `resumeSchedule`         | 200     |
| POST   | `/v1/schedules/{scheduleId}/backfill`     | `backfillSchedule`       | 200     |
| GET    | `/v1/quarantined-tasks`                   | `listQuarantinedTasks`   | 200     |
| POST   | `/v1/quarantined-tasks/{taskId}/release`  | `releaseQuarantinedTask` | 200     |
| GET    | `/v1/admin/namespaces`                    | `adminListNamespaces`    | 200     |
| POST   | `/v1/admin/namespaces`                    | `adminCreateNamespace`   | 201/200 |
| GET    | `/v1/admin/namespaces/{namespace}/keys`   | `adminListKeys`          | 200     |
| POST   | `/v1/admin/namespaces/{namespace}/keys`   | `adminIssueKey`          | 201     |
| POST   | `/v1/admin/keys/{keyId}/revoke`           | `adminRevokeKey`         | 200     |
| GET    | `/v1/admin/namespaces/{namespace}/quota`  | `adminGetQuota`          | 200     |
| POST   | `/v1/admin/namespaces/{namespace}/quota`  | `adminSetQuota`          | 200     |
| GET    | `/v1/admin/audit-log`                     | `adminListAuditLog`      | 200     |
| POST   | `/v1/codec/decode`                        | `decodePayloads`         | 200     |
| POST   | `/v1/codec/encode`                        | `encodePayloads`         | 200     |
| GET    | `/v1/runs/{runId}/stream`                 | not in OpenAPI           | 200     |
| GET    | `/openapi.json`                           | public                   | 200     |

Errors are `{ "error": { "code", "message", "details"? } }`. 403 is a key whose scope does not allow the operation. 400 is a validation failure or a malformed body or cursor, a visibility query that does not parse (`invalid_query`, see below), invalid search attributes, a rejected or unknown update or an unknown query, 409 a closed run, a compacted history, a reset or fork cut the history cannot take, a reused idempotency key with a different request or a workflow key of another type, 413 a body over 1 MiB, and 501 an update or query to an API that does not have the workflow's code.

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

## Signals

`POST /v1/runs/{runId}/signal` takes `{ "name", "payload"?, "signalId"? }` and answers `{ "runId", "sequenceNumber", "duplicate" }`. `signalId` deduplicates: the first signal with an id in the run's continue-as-new chain is recorded, a repeat records nothing and answers `duplicate: true` with the first signal's run and sequence number. A signal sent to a run that continued as new is recorded on the current run of its chain, and `runId` names that run. A signal to a chain whose last run is closed answers 409 `run_closed`.

`POST /v1/signal-with-start` takes `{ "workflowType", "workflowKey", "input"?, "signal": { "name", "payload"?, "signalId"? } }`. `workflowKey` is the run's idempotency key: the run that holds it is signalled; when no run holds it, a run of `workflowType` with `input` is started and signalled in the same transaction (201). Concurrent calls with the same key start exactly one run, and every signal reaches it. A key that holds a run of another type answers 409 `workflow_key_conflict`, an unknown type 400 `unknown_workflow_type`.

## Events

An event is addressed by a name and a correlation key, not by a run id. A workflow waits for one with `ctx.waitForEvent(name, { match, timeoutMs })`:

```ts
const order = defineWorkflow("order", async (ctx, input: { orderId: string }) => {
  const paid = await ctx.waitForEvent<{ amount: number }>("payment.received", {
    match: input.orderId,
    timeoutMs: 24 * 60 * 60 * 1000,
  });
  return paid.amount;
});
```

`POST /v1/events` takes `{ "name", "key", "payload"?, "bufferMs"? }` and answers 202 `{ "eventId", "expiresAt", "deliveredTo": [{ "runId", "waitId" }], "startedRunIds" }`. The event is delivered at once to every run waiting for its name and key, and stays deliverable for `bufferMs` (default one hour, at most seven days, 0 for none) to runs that start waiting later, so an event that arrives before the wait is not lost. Each run receives one event at most once: a second wait in the same run takes the next event. A wait whose timeout fired receives nothing more, and the workflow sees `EventWaitTimeoutError`.

`POST /v1/event-triggers` takes `{ "eventName", "key"?, "workflowType" }` and answers 201 with the trigger. From then on every event of that name (and, with `key`, only that correlation key) starts a run of `workflowType` with the input `{ "eventId", "eventName", "key", "payload" }`, once per event and trigger. `GET /v1/event-triggers` lists them, oldest first.

## Run stream

`GET /v1/runs/{runId}/stream?after=<sequence number>` is a server sent events stream of one run. It sends a `slice` event with `{ events, status, closed }` for the history after `after` (or the `Last-Event-ID` header, which holds the last sequence number sent), keeps polling the database every `streamPollMs` (default 500 ms) and sends a new `slice` whenever events or the status change. When the run has closed and everything was sent it sends an `end` event and closes. A comment line is sent as a heartbeat every 15 seconds. A namespace can have `maxStreamsPerNamespace` streams open (default 20); one more answers 429 `stream_limit_reached` with `Retry-After: 5`. A stream ends after `maxStreamLifetimeMs` (default 15 minutes) with a `reconnect` event instead of `end`, and the client opens a new one with `Last-Event-ID`. The stream needs the bearer key like every other call, so a browser reads it with `fetch` and not with `EventSource`. A run of another namespace answers 404, a cursor that is not a non negative integer answers 400.

## Payload codec and encryption

With a payload codec (`ApiOptions.payloadCodec`, or `WF_ENCRYPTION_KEYS` for `wf serve`, see `docs/DEPLOYMENT.md`), the API encodes every user payload before it stores it: run inputs, signal payloads, update arguments, event payloads and schedule inputs. The worker encodes what workflow and step code produce. Reads return payloads as they are stored: an encoded payload is a JSON object `{ "$dee_codec": "aes-256-gcm", "keyId", "iv", "tag", "data" }` (or `"gzip"` with `data`). Query answers and update results are computed or decoded by the server and come back as plain values.

`POST /v1/codec/decode` with `{ "payloads": [...] }` (at most 1,000) answers `{ "payloads": [...] }` in the same order, with every encoded payload decoded, at any depth (a whole history event can be passed), and with the keys of `ApiOptions.maskFields` (`WF_MASK_FIELDS`) replaced by `"[masked]"`. A value that is not encoded comes back as it is. A payload encrypted with a key the server does not have, or one that was changed, answers 422 `payload_not_decodable`. `POST /v1/codec/encode` encodes. Both need a `read` key. The UI and `wf run describe` show payloads only through the decode endpoint; `--json` prints them as stored.

Ids, types, timestamps, errors, search attributes and the memo are not payloads and stay in clear text, so the engine, the visibility queries and the invariant checker can read them.

## Dead letters

`GET /v1/dead-letters?limit=&cursor=` lists the namespace's step tasks that used all their attempts, oldest first, one page at a time (the namespace filter, the order and the limit run in SQL). A page holds `limit` entries (default 500, at most 1,000) and carries `nextCursor` when more follow. `POST /v1/dead-letters/{deadLetterId}/requeue` puts one back on its queue and answers `{ "taskId" }`; the step already failed for its workflow, so the task is acknowledged without running the step again (see `docs/CONCEPTS.md`); an unknown id, an id of another namespace and an entry that was requeued already all answer 404.

## Reset and fork

A reset or fork starts a new run whose history is copied from an existing run up to a cut, so the steps before the cut are not executed again: the new run replays them from the copied events and goes on from there with the code that is deployed now. `point` names the cut: `{ "kind": "event", "sequence": n }` keeps the events up to `n`, `{ "kind": "step", "step": n }` keeps everything before the `n`th step the run scheduled (that step runs again), and `{ "kind": "failed-step" }` keeps everything before the first step that failed for good.

- `POST /v1/runs/{runId}/reset` with `{ "point", "reason"? }` replaces the run: an open run is terminated with `reason` (default `reset to run <new id>`). It answers 201 with `{ "runId", "resetFromRunId", "kind", "workflowType", "eventSequence", "terminatedOriginal", "rescheduledSteps" }`; `runId` is the new run.
- `POST /v1/runs/{runId}/fork` with `{ "point", "workflowType"? }` starts the new run and leaves the old one as it is. `workflowType` moves the new run onto other code, for example `order-v2`; that code must replay the copied events.
- `GET /v1/runs/{runId}/reset-points` lists the events the history can be cut after, with the step a `step_scheduled` cut keeps last.

The new run is in the same namespace and on the same queue, with the same input, memo, priority and run timeout and the search attributes the run held at the cut. It starts a chain of its own and has no parent. `describeRun` does not show the link yet; the `workflow_runs` columns `reset_from_run_id`, `reset_event_sequence` and `reset_kind` hold it. A step whose `step_scheduled` event the cut kept without its result is executed again at once (`rescheduledSteps`). A cut that keeps a closing event or a cancellation request, or leaves a timer, a child workflow, an event wait without a timeout or an update unfinished, answers 409 `invalid_reset_point` with the reason, as does a run whose history was compacted or purged. Both routes need `operate` and are audited (`run.reset`, `run.fork`).

## Batch operations

`POST /v1/batches` applies one operation to every run of the namespace that a visibility query matches:

```json
{
  "operation": "signal",
  "query": "customerId = 'c-1' and status = 'RUNNING'",
  "signal": { "name": "refund", "payload": { "amount": 10 } },
  "runsPerSecond": 50,
  "reason": "incident 42"
}
```

`operation` is `cancel`, `terminate`, `signal` (needs `signal`), `reset` (needs `resetPoint`, `{ "kind": "step", "step": n }` or `{ "kind": "failed-step" }`) or `requeue` (requeues every dead-lettered step of the run). An empty `query` matches every run. The targets are the runs that match when the batch starts, oldest first, at most 100,000; runs that match later are not added, and the batch's own runs are never targets. The batch runs as a workflow of the built-in type `dee.batch` on the API's queue, so it needs an engine of that queue, which registers the type unless it was started with `batchOperations: false`. It applies `pageSize` targets per step (default 100, at most 1000) and, with `runsPerSecond`, sleeps between pages so the rate is not exceeded. A crashed worker leaves the batch where it stopped, and another worker resumes it; each target is applied and marked done in one transaction, so none is applied twice. A target whose run is closed, missing, has no dead letter to requeue or cannot be cut at the reset point is skipped with the reason. A signal batch sends its signal with the signal id `batch-<batchId>`.

It answers 201 with the batch: `{ "batchId", "operation", "query", "reason", "runId", "status", "total", "applied", "skipped", "remaining", "pageSize", "pageIntervalMs", "createdAt" }`, where `runId` is the first run of the batch workflow and `status` the status of the latest run of its chain. `GET /v1/batches?limit=` lists the batches newest first, `GET /v1/batches/{batchId}` reads one, and `GET /v1/batches/{batchId}/targets?after=&limit=` lists its targets in position order with their `state` (`PENDING`, `APPLIED` or `SKIPPED`), `detail` and `appliedAt`. A malformed batch answers 400 `invalid_batch`, a query that does not parse 400 `invalid_query`, and an unknown batch 404. Starting a batch needs `operate` and is audited (`batch.start`).

## Quarantined tasks

`GET /v1/quarantined-tasks` lists the namespace's tasks that are no longer delivered (see "Poison pills" below), oldest first, with their reason and reclaim count. `POST /v1/quarantined-tasks/{taskId}/release` puts one back on its queue with a fresh reclaim budget and answers `{ "taskId", "runId" }`; a workflow task whose run already has a pending one is merged into it, so the run gets one decision. An unknown id, an id of another namespace and a task that was released already answer 404.

## Admin endpoints and the audit log

The routes under `/v1/admin` need an `admin` key and act on the namespace named in their path or body, not on the caller's:

- `POST /v1/admin/namespaces` with `{ "name" }` creates a namespace (201, or 200 when it exists). `GET` lists them with their number of active keys.
- `POST /v1/admin/namespaces/{namespace}/keys` with `{ "scope", "label"?, "expiresAt"? }` issues a key and answers it once with its secret in `key`; an expiry that is not in the future answers 400 `invalid_key`. `GET` lists the keys without secrets: scope, label, creation, expiry, last use and revocation. `POST /v1/admin/keys/{keyId}/revoke` revokes one (404 when it does not exist or was revoked already).
- `GET /v1/admin/namespaces/{namespace}/quota` reads the limits and the current usage. `POST` changes the limits it is given (`maxConcurrentRuns`, `maxPendingTasks`, `ratePerSecond`, `burst`); `null` removes a limit and a limit left out keeps its value.
- `GET /v1/admin/audit-log?namespace=&cursor=&limit=` reads the audit log newest first, `limit` up to 500 (default 100), with `nextCursor` when a full page came back.

Every successful admin and operator action is appended to the audit log: `namespace.create`, `key.issue`, `key.revoke`, `quota.set`, `run.cancel`, `run.terminate`, `pause.create`, `pause.resume`, `schedule.create`, `schedule.pause`, `schedule.resume`, `schedule.backfill`, `dead_letter.requeue`, `task.release`, `run.reset`, `run.fork` and `batch.start`. An entry holds the actor (key id, label, namespace and scope, copied so it stays readable after the key is revoked), the namespace acted on, the target (a run, schedule, key or task id) and the request body as details; an issued key's secret is never recorded. Refused and failed requests are not recorded. Starts, signals, updates and events are application traffic and are not audited. The `audit_log` table refuses updates and deletes.

## Idempotent start

Send `Idempotency-Key: <1 to 255 characters>` with `POST /v1/runs`. The first call answers 201 and creates the run; any repeat in the same namespace answers 200 with `"created": false` and the same run. Reusing the key with a different workflow type or input answers 409.

`idempotencyTtlMs` in the body limits how long the key maps to its run. A start after the TTL answers 201 with a new run, which takes the key over; the old run keeps running and its `idempotencyKey` becomes `null`. A TTL without a key answers 400 `invalid_start_policy`.

## Debounced and singleton starts

`debounce: { key, windowMs }` folds starts. The first start of a key opens a window of `windowMs`; it and every start of the key inside the window answer 202 with `{ "created": false, "pending": { runId, kind: "debounce", key, workflowType, fireAt, startCount } }`, all with the same `runId`, and each replaces the input. When the window closes, the engine's schedule loop starts one run under that `runId` with the last input. The window counts from the first start; later starts do not extend it. Until it fires, `GET /v1/runs/{runId}` answers 404.

`singleton: { key, whenOpen }` allows one open run per key. A start while no run of the key is open creates the run (201). While one is open, `whenOpen: "refuse"` (the default) answers 409 `singleton_open` with `details: { key, runId }`, and `whenOpen: "queue"` answers 202 with a pending start of kind `singleton` (`fireAt` is null), which the schedule loop starts once no run of the key is open, oldest first. A refusing start is also refused while queued starts of its key wait.

`debounce` cannot be combined with `singleton` or an `Idempotency-Key`, and a queued singleton start cannot carry an `Idempotency-Key`; these answer 400 `invalid_start_policy`.

## Pause and resume

`POST /v1/pauses` with `{ "scope": "run", "runId" }`, `{ "scope": "queue", "queueName"? }` or `{ "scope": "namespace" }` and an optional `reason` holds work back. A queue without `queueName` is the API's own queue, and a queue pause holds only the caller's namespace. The first pause answers 201 with `{ pause, created: true }`; pausing again answers 200 with the first pause. A run pause of an unknown run answers 404 and of a closed run 409 `run_closed`. `POST /v1/pauses/resume` with the same body removes the pause and answers `{ "resumed": true }`, or `false` when nothing was paused. `GET /v1/pauses` lists the namespace's pauses, oldest first.

A pause only stops the dequeue. Paused tasks stay `PENDING` in their order, timers still fire and enqueue their workflow task, signals, updates and events are still recorded, and a task a worker already leased runs to its end. After a resume the next poll leases the held tasks. `GET /v1/runs/{runId}` carries `paused`, the pauses that hold the run back (its own first), when there are any.

## Schedules

`POST /v1/schedules` with `{ name, cronExpression, workflowType, input?, timeZone?, overlapPolicy?, catchUpPolicy?, catchUpWindowMs?, startAt? }` creates a cron schedule on the API's queue; a running engine of that queue starts its runs. A name that exists answers 409 `schedule_exists`, a cron expression or time zone that does not parse 400 `invalid_schedule`. `GET /v1/schedules` lists them by name, `GET /v1/schedules/{id}` reads one and `GET /v1/schedules/{id}/triggers?limit=` lists its latest triggers (`scheduledFor`, `outcome`, `runId`), newest first. A schedule of another namespace answers 404.

`overlapPolicy` decides what a trigger does while a run of the schedule is open:

- `skip` (the default) drops it.
- `buffer_one` keeps the latest one and starts it when the open run closes; an older buffered trigger becomes `SKIPPED`.
- `cancel_other` requests cancellation of the open runs and buffers the trigger like `buffer_one`, so it starts once they have closed and the runs never overlap. The trigger's report lists the cancelled runs in `cancelledRunIds`.
- `allow_all` starts it anyway.

`POST /v1/schedules/{id}/pause` stops a schedule; it starts nothing, not even a buffered trigger. `POST /v1/schedules/{id}/resume` starts again from the next match after now and does not make up the pause. `POST /v1/schedules/{id}/backfill` with `{ from, to, overlapPolicy? }` handles every trigger in `[from, to)` once, paused or not, under the schedule's policy or the one given (`allow_all` starts every hour of a skipping schedule). It answers the triggers this call handled; a trigger handled before, by a tick or another backfill, is left out, so repeating a backfill starts nothing new. A range that ends before it starts or holds more than 1000 triggers answers 400 `invalid_backfill`.

## Listing

`POST /v1/runs` also accepts `runTimeoutMs` and `executionTimeoutMs` (positive numbers, milliseconds). A run that outlives its run timeout, or whose continue-as-new chain outlives the execution timeout, ends `TIMED_OUT`; a zero or negative value answers 400.

`GET /v1/runs?status=&workflowType=&startedAfter=&startedBefore=&query=&limit=&cursor=` returns runs newest first, at most `limit` (1 to 200, default 50). Pass the returned `nextCursor` to get the next page; the last page has none. `startedAfter` (inclusive) and `startedBefore` (exclusive) are ISO 8601 timestamps. Every run in the list carries its `searchAttributes` and `memo`.

## Search attributes, memo and visibility queries

`POST /v1/runs` accepts `searchAttributes`, an object of at most 32 typed values (strings of at most 256 characters, finite numbers, booleans) under identifier names (letters, digits and `_`, at most 64 characters, not `runId`, `status`, `workflowType`, `queueName`, `startedAt`, `closedAt`, `and`, `or`, `not`, `true` or `false`), and `memo`, any JSON value of at most 16 KiB that is shown with the run and never indexed. A workflow changes its attributes with `ctx.upsertSearchAttributes({ stage: "shipped", flagged: null })`: a value replaces, `null` removes. Bad attributes or a bad memo answer 400 `invalid_search_attributes` and write nothing. Both carry over when the run continues as new.

`POST /v1/runs` also accepts `priority`, an integer from -1000 to 1000 (default 0). Workers take the tasks of a higher-priority run first, and child runs and continue-as-new keep the priority. Any other value answers 400 `validation_failed` and writes nothing.

`GET /v1/runs/{runId}` adds `concurrency` for a run whose workflow has a concurrency key: `key`, `limit`, `holders` (runs holding a slot of the key), `holdsSlot` and `waitingForSlot` (the run has a due task that waits because every slot is held). Runs without a key have no such field.

`query` filters the list with a small grammar, combined with the other filters by `and`:

```
status = 'FAILED' and customerId = 'c-1' and startedAt > '2026-11-01T00:00:00Z'
(region = 'eu' or vip = true) and not amount < 100
```

| Field                                          | Literal                        | Operators                        |
| ---------------------------------------------- | ------------------------------ | -------------------------------- |
| `status`, `workflowType`, `queueName`, `runId` | `'string'` (`runId` a uuid)    | `=`, `!=` (or `<>`)              |
| `startedAt`, `closedAt`                        | `'ISO-8601 time'` or `'date'`  | `=`, `!=`, `<`, `<=`, `>`, `>=`  |
| any other name: a search attribute             | `'string'`, number, true/false | all six; booleans only `=`, `!=` |

`and` binds tighter than `or`, parentheses group, `not` negates, keywords are case insensitive and a quote inside a string is written twice (`'it''s'`). An ordering on an attribute only matches values of the literal's type (`amount > 10` skips a run whose `amount` is the string `"50"`); `!=` matches runs that hold the attribute with another value. A query of at most 2000 characters, 32 comparisons and 16 levels of nesting is accepted. The query is compiled into parameterized SQL: every literal and attribute name is a bound parameter, so the text of a query never reaches the SQL. A query that does not parse answers:

```json
{
  "error": {
    "code": "invalid_query",
    "message": "expected a field name but found the end of the query at position 22",
    "details": { "position": 22 }
  }
}
```

`position` is 1-based, the first character of the offending token, or the length of the query plus one for an unexpected end. Equality on an attribute is served by a GIN index and status with start time by a btree index; see `docs/BENCHMARKS.md` for plans over 100,000 runs.

## Rate limits and quotas

Each namespace can carry a row in `namespace_quotas`, written with `createQuotaStore(pool).set(namespaceId, { ... })`. A limit that is `null`, and a namespace without a row, is not enforced.

| Limit                | Field                    | Checked on                          | Answer                    |
| -------------------- | ------------------------ | ----------------------------------- | ------------------------- |
| Request rate         | `ratePerSecond`, `burst` | every `/v1` request                 | 429 `rate_limited`        |
| Concurrent runs      | `maxConcurrentRuns`      | `startRun` (runs in `RUNNING`)      | 429 `run_quota_exceeded`  |
| Pending tasks        | `maxPendingTasks`        | every write (`PENDING` or `LEASED`) | 429 `task_quota_exceeded` |
| Queue depth (global) | `maxQueueDepth` option   | every write                         | 503 `overloaded`          |

Every refusal carries a `Retry-After` header in whole seconds. For the rate limit it is the time until the oldest admission leaves the window; for quotas and queue depth it is `quotaRetryAfterSeconds` (default 5). Limits are per namespace: a namespace that exhausts its rate limit or quota does not change the answers other namespaces get. Reads only spend the rate limit.

The rate limit is kept in Postgres and shared by every api process on the database: a namespace gets `burst` requests (by default `ratePerSecond` rounded up) in any sliding window of `burst / ratePerSecond` seconds, however many processes serve it. `ratePerSecond: 1, burst: 3` therefore admits 3 requests in any 3 seconds.

## Poison pills

A task whose lease expires without an ack is reclaimed by the janitor. After `poisonThreshold` reclaims (default 3) the task is set to `QUARANTINED` instead of `PENDING` and is never delivered again, so a task that crashes every worker that takes it cannot hold up the queue. `GET /v1/quarantined-tasks`, `wf quarantine list` and the UI's quarantine page list them, and `POST /v1/quarantined-tasks/{taskId}/release`, `wf quarantine release` or the page's release button puts one back with a fresh budget (from code: `janitor.listQuarantined(namespaceId?)` and `janitor.releaseQuarantined(taskId, namespaceId?)`). A run whose only open task is quarantined is not recovered as a stalled run.

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
