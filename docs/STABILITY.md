# Stability

This page says what the project promises not to break, how a version number tells you whether it did, and what you can run to check your own workflow changes before they reach production.

## Versions on 0.x

The packages follow semantic versioning, with the usual reading of a `0.x` major version:

- **Minor (`0.1` to `0.2`)**: may break the public API listed below. Every break is listed in the "Breaking" part of the `CHANGELOG.md` section of that release, with what to change. A break that touches the database comes with a migration that `wf migrate up` applies.
- **Patch (`0.2.0` to `0.2.1`)**: never breaks the public API. Bug fixes, new optional options, new exports and new migrations that only add.
- **Pre-releases (`0.2.0-rc.1`)**: no promise beyond the release they lead to.

All eight packages share one version (one Changesets fixed group, see `docs/RELEASING.md`), so `@dee/core@0.2.1` and `@dee/worker@0.2.1` always belong together. Mixing versions across packages is not supported.

From `1.0.0` on, the usual rule applies: only a major version breaks the public API.

## The public API

Only these are covered. Anything else can change in any release.

| Surface              | What is covered                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package exports      | The exports of the `.` entry point of each published package, exactly as recorded in `api-reports/*.api.md`. Deep imports into `dist` or `src` are not covered.                                                                                                       |
| HTTP API             | Every path under `/v1` with its methods, parameters, status codes and the fields of its bodies, as described by `/openapi.json`. New optional request fields and new response fields may be added in a patch release; clients must ignore fields they do not know.    |
| CLI                  | The `wf` commands, their flags and `WF_<NAME>` variables, their exit codes (0, 1, 2) and the output of `--json`. Text output meant for people may change.                                                                                                             |
| Database schema      | The tables, columns and functions created by `packages/core/migrations` as far as `docs/EMBEDDING.md` documents them for direct use (the `start_workflow` function, the `schema` placement). Other tables are internal: read them for debugging, never write to them. |
| History event format | The event types and fields in `packages/core/src/event-store/events.ts` and their meaning, as stored in `run_events` and as written by `wf history export`. See below.                                                                                                |
| Workflow determinism | A history recorded by one release replays on the next release's engine without a `NonDeterminismError` for unchanged workflow code. The fixture gate checks this.                                                                                                     |

Not covered: the web UI (its pages and its internal endpoints may change), log line wording, metric label sets beyond the names in `docs/OBSERVABILITY.md`, the Docker image layout except its entry point and default command, and anything marked experimental in its TSDoc.

## How the public API is checked

- **Exports.** `pnpm run api:check` builds the packages and compares each package's declarations with its report in `api-reports/` (made by `@microsoft/api-extractor`). Any added, removed or changed export fails the check, in the `packages` job of CI. When the change is intended, run `pnpm run api:update`, read the diff of the report and commit it; the diff is what a reviewer reads to decide whether the change is breaking.
- **HTTP API.** `packages/api/src/openapi.test.ts` checks that the OpenAPI document is valid and describes every route. The document is generated from the same schemas the routes use, but responses are not yet compared with a committed copy of it (`docs/DEFERRED.md`).
- **Event format.** `test/history-gate.test.ts` reads every recorded fixture history with today's schema and replays it against the workflows it was recorded with. It fails when an event type is removed, a field is renamed or changes type, or a field becomes required that older histories do not have. It also fails when an event type exists that no fixture covers.

## The history event format

Every stored event carries the version of the event format it was written with (`run_events.event_version`, `version` in `GET /v1/runs/{runId}/history` and in an export). This build writes `CURRENT_EVENT_VERSION`, currently 1.

Rules for changing the format:

1. **Adding an optional field** does not change the version. Older engines ignore the field when they read the event.
2. **Adding an event type**, or giving an existing field a new meaning, raises the version. A new event type needs a recorded fixture before the gate passes.
3. **Removing a field, renaming it, changing its type or making it required** is not allowed while any supported release can have written it. If it has to happen, the new engine keeps reading the old shape (an upgrade step at read time) for at least one minor release, and the change is listed as breaking.

Reading is forward-compatible. An engine that reads an event written by a newer version drops the fields it does not know and keeps working. Only an event type it does not know at all is refused, with `UnsupportedEventError` naming the type and the version and telling you to upgrade the engine, instead of a schema error. In practice: during a rolling upgrade old and new workers can share a database as long as the new release did not add an event type; when it did, upgrade every worker before the new event type gets written (the release notes say when this applies).

The engine writes the version explicitly. The SQL function `start_workflow` relies on the column default (1), so a release that raises `CURRENT_EVENT_VERSION` also ships a migration that moves the default.

## Deprecation

- A deprecated export, flag, endpoint or field keeps working for at least one minor release after the release that deprecates it, and is removed no earlier than the next one.
- Deprecation is announced in three places: the TSDoc gets a `@deprecated` tag naming the replacement, the `CHANGELOG.md` section lists it, and where a running system can say so it does (the CLI prints a warning to stderr, an HTTP response carries a `Deprecation` header). Nothing is deprecated yet.
- Removing something deprecated is a breaking change and is listed as one.
- A workflow code path is retired with `ctx.deprecatePatch()` (see `docs/VERSIONING.md`), not by deleting it, while runs that took it can still be open.

## Testing your own workflow changes: export and replay

A change to workflow code is safe when the histories of runs that are still open (and of runs you might still replay, for example to answer a query) replay against the new code. Check that before deploying:

```sh
# save the history of a few real runs, ideally one per path through the workflow
wf history export 0f6a3a9e-6a54-4c32-9d55-6f0f5a2c1b11 --out histories/order-paid.json
wf history export 9b2c7d10-1e4f-4c32-8d55-6f0f5a2c1b12 --out histories/order-refunded.json

# replay them against the new code
wf replay --module ./src/workflows.ts histories/*.json
```

`wf replay` exits 0 when every history replays and 1 when one does not, printing the run, the file and the event the replay diverged at:

```
ok    run 0f6a... (histories/order-paid.json): 14 events replayed
FAIL  run 9b2c... (histories/order-refunded.json): non determinism at event 6 (step_scheduled): non-deterministic replay at "step-2": history recorded step type "refund" ...
1 passed, 1 failed
```

What counts as compatible: changing a step's implementation, changing how the result is computed from step results, adding work after the point where an open run currently waits, and new code behind `ctx.patched()`. What does not: reordering, adding or removing steps, timers or child workflows before that point, changing a step's input, or removing a `ctx.patched()` branch that recorded runs took.

The same check runs in a test, so the histories can live in your repository and gate every change in CI:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { replayHistories } from "@dee/core";
import { expect, it } from "vitest";
import { workflows } from "../src/workflows.ts";

it("replays every recorded history against the current code", async () => {
  const histories = readdirSync("histories").map((file) => ({
    source: file,
    history: JSON.parse(readFileSync(`histories/${file}`, "utf8")) as unknown,
  }));
  const report = await replayHistories(workflows, histories);
  expect(report.results.filter((result) => !result.passed)).toEqual([]);
});
```

No step runs and no database is needed: the replay serves every step result from the history. `formatReplayResult` turns a result into the line `wf replay` prints.

The engine's own fixtures work the same way: `test/fixtures/history-gate/` holds the workflows, `pnpm run history-gate:record` records their histories against a real engine, and `test/history-gate.test.ts` is the gate.
