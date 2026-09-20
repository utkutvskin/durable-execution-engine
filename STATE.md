# State

Every session updates this file per A1 and A2. The newest entry sits at the top. Each entry must be readable on its own, with no need to consult the previous day's note.

Field glossary:

- **Day:** the day number in the backlog.
- **Status:** `IN_PROGRESS` | `DONE` | `BLOCKED`.
- **Completed day:** when this entry is written at close, the last day number that reached DONE. The next session computes its own day number from here.
- **Files added or changed:** a short list.
- **Technical decisions:** references to any ADRs added to `docs/DECISIONS.md`.
- **BLOCKER:** when filled in, the next session clears this before anything else. Otherwise `-`.
- **Handoff note:** the one line that must not be forgotten tomorrow.

---

## Day 1: monorepo skeleton and CI

- **Status:** DONE
- **Completed day:** 1
- **Files added or changed:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`, `README.md`, `docs/DECISIONS.md`, `docs/OUT_OF_SCOPE.md`, `packages/{core,worker,api,cli}`, `apps/ui`, `examples/README.md`, `test/tooling/*`
- **Technical decisions:** ADR-0001 through ADR-0004 in `docs/DECISIONS.md` (workspace layout, shared strict tsconfig, eslint strictness, postgres only via compose/CI service container)
- **BLOCKER:** -
- **Handoff note:** `pnpm install && pnpm run verify` is green (11 test files, 18 tests). `docker compose up -d` was not run to completion in this session: the sandbox's egress policy blocks Docker Hub pulls (`403` on `production.cloudfront.docker.com`, confirmed as a policy denial via the agent proxy status, not a transient failure). `docker compose config` validates the file's syntax and resolved defaults without pulling. GitHub Actions CI pulls `postgres:16` as an unrestricted service container, so this should not block CI; the next session should confirm CI is actually green on the pushed commit before trusting this further. Day 2 (database schema and migrations) is the first day that needs postgres to actually be reachable — if the same pull restriction holds there, it needs handling in the failure protocol at that point, not this one.

---

## Day 0 (bootstrap)

- **Status:** DONE
- **Completed day:** 0
- **Files added or changed:** `docs/BACKLOG.md`, `STATE.md`, `docs/CONVENTIONS.md`, `CLAUDE.md`
- **Technical decisions:** -
- **BLOCKER:** -
- **Handoff note:** Start from day 1 (monorepo skeleton and CI). Read `docs/CONVENTIONS.md` before you start; A1 step 2 is mandatory.
