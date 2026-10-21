# Roadmap

v0.1.0 is a complete single-database engine. This page lists what comes next, in the order the owner expects to take it. Nothing here is a promise of a date.

## Next (v0.2)

- **Publish.** Push the image to a registry from CI on a tag, and publish `@dee/*` as packages built to JavaScript, so `npx wf dev` works without a checkout (`docs/DEFERRED.md`, day 29).
- **Production entry points.** A `wf api` command (API without a worker), flags for pool size and worker concurrency, and switches in the `wf` commands for tracing, quotas and the history compactor.
- **Admin surface.** Endpoints and `wf` commands to create namespaces, issue and revoke keys and set quotas, which are code-only today.
- **Step tasks in the decision's transaction.** Enqueue a scheduled step's task in the same transaction as its event, removing the 60 second delay after a crash between the two (`docs/DEFERRED.md`).
- **Release checks.** Run the chaos suite in CI, and run the Jaeger and compose paths that the build environments of v0.1.0 had no Docker daemon for.

## Later

- Fewer statements per run (about 47 today), the main throughput lever listed in `docs/BENCHMARKS.md`.
- A list level event stream for the ui instead of polling, an endpoint and view for quarantined tasks.
- Signals with a dedup key, and queries over HTTP.
- Workflow and step SDK generators for other languages, over the HTTP API.
- A shared rate limiter between API processes.
- A licence. The package metadata says `UNLICENSED` until the owner chooses one.

## Not planned

Distributed consensus, a custom storage engine, gRPC, a Kubernetes operator and multi-region operation are outside the project (`docs/OUT_OF_SCOPE.md`).
