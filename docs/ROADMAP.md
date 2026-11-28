# Roadmap

v0.2.0 is a single-database engine that a team can adopt: published packages and an image, a full authoring API, flow control, a schema that scales with partitions and retention, and an operations surface with scoped keys, an audit log, encryption, reset and batch operations. This page lists what comes next, in the order the owner expects to take it. Nothing here is a promise of a date.

## Next candidates (v0.3)

- **Streamed step output.** A step that produces output while it runs (tokens of a model, rows of an export, progress lines) streams it to the API and the UI instead of returning it all at the end. The stream is not part of the history, so replay stays unchanged; only the final result is recorded.
- **Worker deployment versioning.** Workers declare a deployment version, and a run stays on the version it started on until it closes or is moved on purpose. This replaces most uses of `ctx.patched` for code that changes between deployments, and gives a safe way to drain an old version.
- **A step-only worker SDK over HTTP.** A worker in any language polls step tasks, heartbeats and reports results over the HTTP API, without a Postgres connection. Workflows stay in TypeScript; steps can be written where the code they call already lives.
- **Interceptors.** Hooks around starting a run, deciding, running a step and handling a signal or update, for logging, metrics, authorization and context propagation, without wrapping every definition by hand.
- **Keyed entities.** A long-lived workflow addressed by a business key (an account, a cart, a device) that receives signals and updates in order, continues as new on its own, and is started on first use.

## Deferred from v0.2

These were named in a day's scope and not finished or not proven. Each has an entry in `docs/DEFERRED.md` that says what is missing.

- **Publishing for real.** The release pipeline publishes nothing until the owner does the one-time npm and GHCR steps of `docs/RELEASING.md`, and the release tags are pushed by the owner because the agent sessions cannot push tags.
- **Statements per run.** The engine's own three-step run still takes more statements than the benchmark's recorder path; folding the reads before a step and the markers after a decision is the next throughput lever (`docs/BENCHMARKS.md`).
- **Benchmarks on more than one machine**, with workers apart from a remote Postgres.
- **Chaos with control of the server**: restarting Postgres under load, an fsync stall, a full disk, packet loss between hosts.
- **Edges of the v0.2 features**: timers and children across a reset cut, a batch cancel route, batch and audit retention, namespace-scoped admins, key rotation, re-encryption of old payloads, `wf replay` of encrypted histories, admin pages in the UI, a replica lag metric, archives outside the local disk.
- **Examples against a real provider and warehouse**, and a Jaeger check of the span tree.

## Later

- Workflow SDK generators for other languages, over the HTTP API.
- A list level event stream for the UI instead of polling.
- A shared rate limiter between API processes.

## Not planned

Distributed consensus, a custom storage engine, gRPC, a Kubernetes operator and multi-region operation are outside the project (`docs/OUT_OF_SCOPE.md`).
