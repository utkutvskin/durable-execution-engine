# Examples

Two complete applications live under `examples/`. Each is a workspace package that exports `workflows`, `steps` and a `demo`, so `wf dev --example <name>` can run it and `wf example <name>` can play its story. Both keep their external system (a payment provider, a warehouse) in memory so they run anywhere; the steps talk to a small interface, and a real provider would implement the same interface.

Run one end to end with a single command:

```sh
pnpm run example:payment       # or: npx wf example payment-saga
pnpm run example:etl           # or: npx wf example etl-pipeline
npx wf example all
```

`wf example` makes sure Postgres answers, migrates, starts the api and a worker in the process, plays the scenarios through the http api and prints one line per claim. It exits 0 when every claim held. The examples' own tests run with `pnpm run test:examples` and in the `examples` job of CI, which also runs both commands.

## Payment saga (`examples/payment-saga`)

The workflow `payment-saga` takes `{ orderId, customerId, amountCents, approvalTimeoutMs? }`.

1. `payments.reserve` puts a hold on the card. The gateway call is idempotent per order.
2. A compensation is registered: if the run is cancelled from here on, `payments.release` lifts the hold.
3. An order of 1,000.00 or more waits for a signal named `approval` (`{ "approved": true }`) or for the timeout, whichever comes first (`ctx.select` over `ctx.waitForSignal` and `ctx.sleep`). A refusal or a timeout releases the hold and ends the run `compensated`.
4. `payments.capture` turns the hold into a charge. It retries a provider timeout with a backoff; a `CardDeclinedError` is not retried and sends the run down the compensation path.
5. `payments.send-receipt` finishes the run `captured`.

The demo plays five orders: a plain payment, an approval by signal, a declined card, a provider timeout that is retried, and a cancellation while waiting for approval. Each is checked against the run and against what the gateway recorded.

## ETL pipeline (`examples/etl-pipeline`)

The workflow `etl-pipeline` takes `{ day?, batchSize?, concurrency? }`; `day` defaults to the day of `ctx.now()`.

1. `etl.list-partitions` returns the source partitions of the day.
2. One child workflow `etl-partition` per partition runs with bounded parallelism (`ctx.all` with `concurrency`, default 2). Each child extracts the partition (`etl.extract`, retried on a flaky source), transforms it (invalid rows are rejected) and loads it in batches (`etl.load`, an upsert by row id).
3. `etl.summarize` writes the day's summary.

Because the load is an upsert, a retried step or a repeated day leaves the destination unchanged. `scheduleNightlyEtl` creates the cron schedule `0 2 * * *` with an empty input; every scheduled run therefore processes the day of its own start. The demo processes a day, shows the retried partition, repeats the day, and backfills the schedule over three past nights with `ScheduleManager.backfill`.

## Writing your own

Copy the shape of an example: pure workflow functions that only use `ctx`, steps that wrap side effects behind an interface and are safe to run twice, and an `index.ts` that exports `workflows` and `steps`. Run it with `npx wf dev --module path/to/index.ts`.
