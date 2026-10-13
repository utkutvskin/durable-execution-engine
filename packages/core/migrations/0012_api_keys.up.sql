create table api_keys (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id),
  key_hash text not null unique,
  label text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index api_keys_namespace_idx on api_keys (namespace_id);

alter table workflow_runs add column idempotency_key text;
create unique index workflow_runs_idempotency_key_idx
  on workflow_runs (namespace_id, idempotency_key)
  where idempotency_key is not null;
create index workflow_runs_namespace_started_idx
  on workflow_runs (namespace_id, started_at desc, id desc);
