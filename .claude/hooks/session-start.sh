#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

if command -v service >/dev/null 2>&1 && ! pg_isready -q -h localhost -p 5432; then
  service postgresql start >/dev/null
fi

for _ in $(seq 1 30); do
  pg_isready -q -h localhost -p 5432 && break
  sleep 1
done

as_postgres() {
  if [ "$(id -un)" = "postgres" ]; then
    "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u postgres -- "$@"
  else
    su postgres -c "$(printf '%q ' "$@")"
  fi
}

if ! as_postgres psql -tAc "select 1 from pg_roles where rolname = 'dee'" | grep -q 1; then
  as_postgres psql -q -c "create role dee with login superuser password 'dee'"
fi

if ! as_postgres psql -tAc "select 1 from pg_database where datname = 'dee'" | grep -q 1; then
  as_postgres psql -q -c "create database dee owner dee"
fi

pnpm install

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export DATABASE_URL=postgres://dee:dee@localhost:5432/dee' >> "$CLAUDE_ENV_FILE"
fi
