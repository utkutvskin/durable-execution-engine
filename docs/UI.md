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
- **Runs.** A table of the namespace's runs with filters for status, workflow type and a start date range, "load more" paging through the api's cursor, and a refresh every 3 seconds. The namespace column shows the namespace of the key, because the api never shows another one.
- **Run detail.** The status, three viewers (input, output, error) and the event history as a timeline: label, summary, offset from the first event, and the raw event on click. The timeline is kept live by the run stream (`GET /v1/runs/{runId}/stream`, see `docs/API.md`): new events are appended without a page refresh, and the stream reconnects from the last sequence number it received.
- **Signal.** A name and an optional json payload, sent with `POST /v1/runs/{runId}/signal`. The form is disabled once the run is closed.
- **Cancel.** Requests a graceful cancellation. The timeline shows `cancel requested` at once and `run cancelled` when the workflow has reacted.
- **Dead letters.** The step tasks that ran out of attempts, with a requeue button.

Run data is always inserted as text nodes, never as markup, so an input such as `<img onerror=...>` is displayed and not executed.

## Tests

- Unit tests for the pure client modules (`timeline`, `sse`, `query`, `format`, `api`) and for the static handler sit next to the code.
- `test/e2e/explorer.e2e.test.ts` drives the real ui in headless Chromium through Playwright against the real api and a real Postgres. It uses `playwright-core` and the Chromium that is installed on the machine: the path is `PLAYWRIGHT_CHROMIUM_PATH` and defaults to `/opt/pw-browsers/chromium`. The test plays the worker itself (it decides the workflow and runs the steps when it calls `pump()`), so the timeline only moves when the test lets it.

## Limits

- Nothing starts the api, the ui and a worker together in a running process yet; the entry points are a later day.
- There is no list level stream: the run list polls.
- The quarantined tasks of the janitor (`docs/API.md`, poison pills) have no ui or endpoint; only dead letters do.
- A run's workflow code can only be decided in a process that does not also need `setTimeout` in the same tick: workflow decisions patch the global `setTimeout`, `Date.now` and `Math.random` while they run. The api handler uses `node:timers` and `node:perf_hooks` for this reason, and a pool shared with it must be created with `idleTimeoutMillis: 0`.
