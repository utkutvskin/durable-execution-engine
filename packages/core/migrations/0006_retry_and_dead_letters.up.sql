create table step_attempts (
  id bigserial primary key,
  run_id uuid not null references workflow_runs (id),
  step_id text not null,
  attempt integer not null,
  error jsonb not null,
  retry_at timestamptz,
  created_at timestamptz not null default now(),
  constraint step_attempts_run_id_step_id_attempt_key unique (run_id, step_id, attempt),
  constraint step_attempts_attempt_check check (attempt > 0)
);

create table dead_letters (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id),
  run_id uuid not null references workflow_runs (id),
  step_id text not null,
  queue_name text not null,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null,
  error jsonb not null,
  reason text not null,
  created_at timestamptz not null default now(),
  requeued_at timestamptz,
  constraint dead_letters_reason_check check (reason in ('MAX_ATTEMPTS_EXHAUSTED'))
);

create unique index dead_letters_open_step_idx
  on dead_letters (run_id, step_id) where requeued_at is null;
create index dead_letters_run_id_idx on dead_letters (run_id);
