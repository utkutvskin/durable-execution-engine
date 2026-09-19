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

## Day 0 (bootstrap)

- **Status:** DONE
- **Completed day:** 0
- **Files added or changed:** `docs/BACKLOG.md`, `STATE.md`, `docs/CONVENTIONS.md`, `CLAUDE.md`
- **Technical decisions:** -
- **BLOCKER:** -
- **Handoff note:** Start from day 1 (monorepo skeleton and CI). Read `docs/CONVENTIONS.md` before you start; A1 step 2 is mandatory.
