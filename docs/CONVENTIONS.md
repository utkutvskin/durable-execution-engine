# Conventions

This file holds the project owner's standing preferences. Every session reads it first (`docs/BACKLOG.md`, section A1 step 2). Where this file and the backlog disagree on how something is written, this file wins.

These rules belong to the repository, not to a machine. They apply whatever agent, tool or machine is running.

---

## 1. Everything is written in English

Every word committed to this repository or published to GitHub is English.

That covers commit messages, PR titles and descriptions, branch names, code identifiers, log and error messages, test names, TSDoc, README, every file under `docs/`, and every new entry in `STATE.md`.

---

## 2. Lowercase

Text written into the repository or into GitHub is lowercase. Only proper nouns start with a capital.

**Lowercase applies to:** commit messages, PR titles and descriptions, branch names, tag messages, log and error messages, and test names.

**Normal sentence capitalization applies to:** prose inside `README.md` and the files under `docs/`, so that documents stay readable. Every commit string, command, identifier or state constant quoted inside a document still follows its own casing rule.

**Exceptions that keep their real casing:**

- Proper nouns: `TypeScript`, `PostgreSQL`, `Postgres`, `Node`, `Docker`, `GitHub`, `Vitest`, `Prometheus`, `Grafana`, `Jaeger`, `OpenTelemetry`, `Playwright`.
- Code identifiers, spelled exactly as the code spells them: `EventStore`, `ConcurrencyError`, `NonDeterminismError`, `RetryPolicy`, `ctx.sleep()`, `parentClosePolicy`.
- Established acronyms: `API`, `CLI`, `UI`, `DSL`, `CI`, `SQL`, `HTTP`, `REST`, `ADR`, `DLQ`, `LRU`, `SSE`, `ETL`.
- State constants as the code declares them: `RUNNING`, `COMPLETED`, `CANCELLED`.

**Commit message examples:**

```
feat(core): append-only event store with optimistic concurrency
fix(worker): renew lease before visibility timeout expires
test(core): recorded history replay harness
chore(state): day 07 complete
```

The type is already lowercase. The description stays lowercase too. A commit subject never starts with a capital.

---

## 3. No comments in code

The code explains itself. Do not write explanatory comments inside function bodies.

**Allowed:**

- TSDoc on every exported symbol. Backlog A6 requires it. TSDoc documents the contract a caller depends on, not the implementation.
- A lint or type suppression that carries its reason on the same line, for example `@ts-expect-error <reason>`. Backlog A6 requires the reason.

**Not allowed:**

- A comment that restates what the line below it does.
- Phase-narrating comments such as `// step 1: load` or `// now validate`.
- Commented-out code. Delete it; git remembers.
- `TODO` and `FIXME`. Unfinished work goes to the `BLOCKER` field in `STATE.md` or to `docs/DEFERRED.md`, where it is actually tracked.

If a piece of code needs a comment to be understood, rename it, extract it, or reshape it until it does not.

If a genuinely non-obvious constraint cannot be expressed in code, such as an external system's bug or a protocol quirk, encode it as a test with a descriptive name instead of a comment. A test fails when the constraint is violated; a comment does not.

---

## 4. No AI attribution

Commit messages carry no `Co-Authored-By: Claude ...` line or anything like it. PR descriptions carry no "Generated with Claude Code" line or anything like it. No AI tool appears as an author in commit or PR text.

**Why:** the owner publishes this work under their own name and does not want an AI tool in the GitHub contributor list. GitHub counts a tool as a contributor the moment such a trailer appears.

An agent running Claude Code can also switch this off at the machine level:

```json
// ~/.claude/settings.json
{ "attribution": { "commit": "", "pr": "" } }
```

That setting is local to one machine and does not bind an agent running elsewhere or under a different tool. This file is what binds.

---

## 5. Attribution added by mistake

Backlog A3 forbids `git push --force` and history rewrites.

- Not pushed yet: fix it with `git commit --amend`.
- Already pushed: do not try to fix it. Write the commit hash into the `BLOCKER` field in `STATE.md` and leave it to the owner. Rewriting published history is the owner's decision.
