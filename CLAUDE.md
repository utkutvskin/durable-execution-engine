# Agent instructions

`docs/BACKLOG.md` is the only source of work. Each session covers one day of it, in order.

## Read this at the start of every session, in order

1. `docs/CONVENTIONS.md` — the owner's writing and commit preferences. Mandatory, never skipped, read before writing any text at all.
2. `STATE.md` — the top entry. If `BLOCKER` is filled in, clearing it is the first task of the day.
3. `docs/BACKLOG.md` — section A (operating instructions) and only today's day block.

Then follow the A1 steps in `docs/BACKLOG.md` in order. Close the session with A2.

## Today's day number

The `Completed day` value of the most recent `DONE` entry in `STATE.md`, plus one. If the most recent entry is `BLOCKED`, the day number does not advance and the same day continues.

## Short reminder

The details are in `docs/CONVENTIONS.md`, which wins on any conflict.

- Everything written into this repository is English.
- Text written into the repository or into GitHub is lowercase. Only proper nouns, code identifiers and established acronyms are capitalized.
- No comments inside function bodies. TSDoc on exported symbols is required and is not a comment in this sense.
- No AI attribution in commit messages or PR descriptions, and every commit is authored as the owner: `git config user.name`/`user.email` (local, not global) are set to the owner's identity before the first commit of the session. See `docs/CONVENTIONS.md`, section 4.
- No `git push --force` and no history rewrites.
- No feature without a test. At least 5 meaningful new tests per day.
- Do not do tomorrow's work today.
