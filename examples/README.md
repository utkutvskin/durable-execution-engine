# Examples

- `payment-saga`: reserve, approve, capture and compensate card payments.
- `etl-pipeline`: a daily load fanned out over partitions with retries and a nightly cron schedule.
- `outbox`: an order insert and the start of its workflow in one transaction, and the same start from a trigger (`docs/EMBEDDING.md`). It is not published.

Both are described in `docs/EXAMPLES.md`. Run them with `pnpm run example:payment` and `pnpm run example:etl`, or look at them in the web ui with `npx wf dev`.
