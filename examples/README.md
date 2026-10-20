# Examples

- `payment-saga`: reserve, approve, capture and compensate card payments.
- `etl-pipeline`: a daily load fanned out over partitions with retries and a nightly cron schedule.

Both are described in `docs/EXAMPLES.md`. Run them with `pnpm run example:payment` and `pnpm run example:etl`, or look at them in the web ui with `npx wf dev`.
