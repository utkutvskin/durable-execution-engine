# Run explorer

The web ui is a small single page app in `apps/ui`. It talks to the HTTP api with the api key of one namespace and has no server side of its own beyond serving its files.

## Serving it

`createUiHandler()` from `@dee/ui` returns a function `(request, response) => boolean` that serves `/ui/` (the html shell), `/ui/assets/<name>` (the modules and the stylesheet) and redirects `/` to `/ui/`. Pass it to the api as `sideHandler`:

```ts
const api = createApiServer(pool, { queueName: "default", sideHandler: createUiHandler() });
```

The ui is then on the same origin as the api, so there is no CORS. The files in `apps/ui/src/client` are TypeScript; the handler strips the types with `node:module`'s `stripTypeScriptTypes` when it is created and serves plain JavaScript, so there is no build step and no bundler. The responses carry a `Content-Security-Policy` of `default-src 'self'`.

## What it shows

- **Sign in.** The api key is typed into a form and kept in `sessionStorage` only. A 401 anywhere returns to the form.
- **Runs.** A table of the namespace's runs with filters for status, workflow type, a start date range and a search box that takes a visibility query (`customerId = 'c-1' and amount > 10`, see `docs/API.md`), a column with each run's search attributes, "load more" paging through the api's cursor, and a refresh every 3 seconds. The namespace column shows the namespace of the key, because the api never shows another one.
- **Run detail.** The status, three viewers (input, output, error) and the event history as a timeline: label, summary, offset from the first event, and the raw event on click. Input, output and events that hold encoded payloads are shown only after the codec endpoint (`POST /v1/codec/decode`) decoded and masked them; if it refuses, the UI shows a placeholder, never the ciphertext. The timeline is kept live by the run stream (`GET /v1/runs/{runId}/stream`, see `docs/API.md`): new events are appended without a page refresh, and the stream reconnects from the last sequence number it received.
- **Signal.** A name and an optional json payload, sent with `POST /v1/runs/{runId}/signal`. The form is disabled once the run is closed.
- **Update and query.** One form with a name and an optional json argument. "send update" posts it with `POST /v1/runs/{runId}/updates/{name}` and shows the handler's result, or the validator's message when the update was rejected; it is disabled once the run is closed. "run query" reads `GET /v1/runs/{runId}/queries/{name}` and shows the answer.
- **Cancel.** Asks for confirmation, then requests a graceful cancellation. The timeline shows `cancel requested` at once and `run cancelled` when the workflow has reacted.
- **Pause.** The run page shows a hint when a pause holds the run back (its own, its queue's or the namespace's) and a "pause run" button that turns into "resume run" while the run's own pause is in force.
- **Reset and fork.** The run page lists the events its history can be cut after (`GET /v1/runs/{runId}/reset-points`), with the step each step cut runs again. "reset to here" asks for confirmation, replaces the run (an open run is terminated) and opens the new run; "fork from here" starts the new run beside it, under the workflow type typed next to it if one is given.
- **Batches.** A page with a form that starts a batch operation (cancel, terminate, signal with a name and an optional json payload, reset before each run's failed step, or requeue) over a visibility query, at an optional rate, after a confirmation, and a table of the namespace's batches with their status and progress. The status links to the batch's workflow run.
- **Schedules and pauses.** A page with the namespace's pauses, each with a resume button, buttons that pause the API's queue or the namespace (after a confirmation), and the schedules with their cron, overlap policy, state and next fire time, a pause or resume button and a backfill form whose two times are read as UTC.
- **Dead letters.** The step tasks that ran out of attempts, with a requeue button. Since day 37 the failure is already final for the workflow, so a requeue only acknowledges the entry.
- **Quarantine.** The tasks the engine stopped delivering (`GET /v1/quarantined-tasks`), with their run, type, queue, reason and quarantine time, and a release button that asks for confirmation and puts the task back on its queue. A key without the `operate` scope sees the list, and a release shows the API's 403 message in the banner and leaves the task quarantined.

Run data is always inserted as text nodes, never as markup, so an input such as `<img onerror=...>` is displayed and not executed.

## Tests

- Unit tests for the pure client modules (`timeline`, `sse`, `query`, `format`, `api`) and for the static handler sit next to the code.
- `test/e2e/explorer.e2e.test.ts` drives the real ui in headless Chromium through Playwright against the real api and a real Postgres. It uses `playwright-core` and the Chromium that is installed on the machine: the path is `PLAYWRIGHT_CHROMIUM_PATH` and defaults to `/opt/pw-browsers/chromium`. The test plays the worker itself (it decides the workflow and runs the steps when it calls `pump()`), so the timeline only moves when the test lets it.

## Limits

- Nothing starts the api, the ui and a worker together in a running process yet; the entry points are a later day.
- There is no list level stream: the run list polls.
- The UI does not read the key's scope, so buttons a `read` key may not use are shown and answer with the API's 403 message.
- Namespaces, keys, quotas and the audit log have no page; they are managed with the `wf namespace`, `wf keys`, `wf quota` and `wf audit` commands (`docs/CLI.md`).
- A run's workflow code can only be decided in a process that does not also need `setTimeout` in the same tick: workflow decisions patch the global `setTimeout`, `Date.now` and `Math.random` while they run. The api handler uses `node:timers` and `node:perf_hooks` for this reason, and a pool shared with it must be created with `idleTimeoutMillis: 0`.

## Hardening (day 38)

- The timeline shows one row per sequence number. The client remembers the last sequence it showed, so a dropped stream resumes from there, and rows that arrive twice (a server that replays from an older position) are merged by sequence number.
- A stream refused with 429 (the per namespace cap) is retried like a dropped one; the indicator reads `reconnecting`.
- Cancelling a run and requeueing a dead letter ask for confirmation with the browser's `confirm` dialog; dismissing it does nothing.
- The content security policy is `default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, so the page cannot be framed.
- The dead letter list follows the API cursor, up to 10 pages (5,000 entries).
