#!/usr/bin/env bash
# Records test/fixtures/upgrade-v0.1.1/fixture.json with the code of the v0.1.1 release.
# Usage: test/fixtures/upgrade-v0.1.1/record.sh [commit], with DATABASE_URL pointing at Postgres.
set -euo pipefail

commit="${1:-b26e5d9}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
checkout="$(mktemp -d)/v0.1.1"

git -C "$repo" worktree add --detach "$checkout" "$commit"
trap 'git -C "$repo" worktree remove --force "$checkout"' EXIT

target="$checkout/test/fixtures/upgrade-v0.1.1"
mkdir -p "$target"
cp "$here/workflows.ts" "$target/workflows.ts"
cp "$here/record.ts" "$target/record.test.ts"

(cd "$checkout" && pnpm install --frozen-lockfile && \
  UPGRADE_FIXTURE_OUT="$here/fixture.json" pnpm exec vitest run test/fixtures/upgrade-v0.1.1/record.test.ts)
npx prettier --write "$here/fixture.json"
