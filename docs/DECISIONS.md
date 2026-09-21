# Architecture decision records

Format: Context / Decision / Consequence. Newest entry at the bottom.

---

## ADR-0001: pnpm workspaces with a flat `packages/*` + `apps/*` layout

**Context:** the stack is fixed to pnpm workspaces (`docs/BACKLOG.md`), with five
independently publishable units: `core`, `worker`, `api`, `cli`, `ui`, plus a
non-package `examples` directory added on day 29.

**Decision:** one `pnpm-workspace.yaml` globbing `packages/*`, `apps/*` and
`examples/*`. `apps/ui` sits outside `packages/*` because it is a deployable
application, not a library other packages depend on. Packages are scoped
`@dee/*` and depend on each other via `workspace:*`.

**Consequence:** `packages/core` has no dependency on any other workspace
package, keeping it usable standalone. `worker`, `api` and `cli` depend on
`core`. Adding a new package later is a new directory plus one workspace
glob match, no config change.

---

## ADR-0002: one shared strict `tsconfig.base.json`, per-package `typecheck`

**Context:** the quality bar (`docs/BACKLOG.md`, A6) forbids `any` and
requires strict typing across every package.

**Decision:** a single `tsconfig.base.json` at the repository root carries
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
related flags. Each package's `tsconfig.json` only extends it and sets
`rootDir`/`outDir`. The root `typecheck` script runs `pnpm -r run
typecheck`, so a package cannot silently opt out of strictness.

**Consequence:** a new package's baseline is strict by default. Loosening a
flag means editing one file, visible in review, rather than drifting per
package.

---

## ADR-0003: eslint flat config with `strictTypeChecked`, `any` as an error

**Context:** A6 forbids `any` outright and requires `unknown` with
narrowing instead.

**Decision:** `eslint.config.js` uses `typescript-eslint`'s
`strictTypeChecked` and `stylisticTypeChecked` presets with
`projectService: true`, and turns `@typescript-eslint/no-explicit-any` into
an error rather than relying on convention. `eslint-config-prettier` is
applied last so formatting is prettier's job alone, never eslint's.

**Consequence:** `any` fails `pnpm run lint`, not just code review. Style
disagreements between eslint and prettier cannot happen because eslint's
stylistic rules that conflict with prettier are disabled.

---

## ADR-0004: postgres 16 only through docker compose, no embedded database

**Context:** the stack is fixed to PostgreSQL 16. Integration tests need a
real database (`docs/BACKLOG.md`, A6: "integration tests run against a real
postgres").

**Decision:** `docker-compose.yml` runs a single `postgres:16` service with
a healthcheck, configured from `.env.example`. CI starts the same image as
a GitHub Actions service container rather than a separate managed
database, so local and CI environments match.

**Consequence:** `pnpm run verify` alone (without `docker compose up -d`)
does not exercise anything that touches postgres yet, since no
database-backed code exists before day 2. From day 2 onward, integration
tests require the compose service (or an equivalent) to be running.

---

## ADR-0005: a hand-written SQL migration runner over `node-pg-migrate`

**Context:** day 2 (`docs/BACKLOG.md`) allows either "your own simple
migration runner or `node-pg-migrate`". A5 prefers writing core runtime
logic in-house and reserves third-party packages for things like
cryptography, date/time and the queue, none of which a migration runner is.

**Decision:** `packages/core/src/db/migrator.ts` is a small hand-written
runner: migrations are plain `<id>.up.sql` / `<id>.down.sql` file pairs
under `packages/core/migrations`, applied in filename order inside
individual transactions, tracked in a `schema_migrations` table.
`migrateUp`/`migrateDown` are plain functions over a `pg.Pool`, so they are
directly unit-testable without shelling out to a CLI. The only new runtime
dependency is `pg` itself, the client every approach needs regardless.
`packages/core/src/db/cli.ts` is a thin wrapper exposing `up`/`down` to
`pnpm run migrate:up` / `migrate:down`.

**Consequence:** no migration-numbering conventions or config file format
to learn beyond ours; adding a migration is adding a pair of `.sql` files.
The runner does not support down-migrations to an arbitrary target version
in one call (only `steps` most-recent, default 1) or migration name
collision checks beyond filename uniqueness; if either is needed later, it
is a small addition to `migrator.ts`, not a new dependency.

---

## ADR-0006: integration tests get a fresh Postgres schema per test file, not Testcontainers

**Context:** A6 requires integration tests to run against a real Postgres
and explicitly allows either Testcontainers or an ephemeral schema on
compose. Day 2 additionally requires that two test files running at the
same time do not see each other's data.

**Decision:** `packages/core/src/db/test-harness.ts` exposes
`createIsolatedSchema`/`createIsolatedDatabase`: each call opens one
Postgres connection, `create schema`s a fresh, randomly named schema, and
returns a `pg.Pool` whose connections default to it via the `-c
search_path=<schema>` connection option, so table-unqualified SQL is
already scoped correctly. `createIsolatedDatabase` additionally runs
`migrateUp` against that schema. `close()` drops the schema and ends both
pools. Every test file calls this once against the same running Postgres
instance (compose locally, the CI service container, or a natively
installed Postgres where Docker is unavailable) rather than starting a
throwaway container per file.

**Consequence:** test files run in true isolation from each other without
paying a container-startup cost per file, and the same Postgres instance
serves every test file in a run. This relies on a reachable Postgres
existing before `pnpm run test` runs (the compose service, CI's service
container, or an equivalent); it does not provision one itself the way
Testcontainers would.
