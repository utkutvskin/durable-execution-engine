create table schedules (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id),
  name text not null,
  cron_expression text not null,
  time_zone text not null default 'UTC',
  workflow_type text not null,
  input jsonb not null default '{}'::jsonb,
  overlap_policy text not null default 'skip',
  state text not null default 'ACTIVE',
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  buffered_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedules_name_key unique (namespace_id, name),
  constraint schedules_overlap_policy_check
    check (overlap_policy in ('skip', 'buffer_one', 'allow_all')),
  constraint schedules_state_check check (state in ('ACTIVE', 'PAUSED'))
);

create index schedules_due_idx on schedules (next_fire_at) where state = 'ACTIVE';

create table schedule_triggers (
  id bigserial primary key,
  schedule_id uuid not null references schedules (id) on delete cascade,
  scheduled_for timestamptz not null,
  outcome text not null,
  run_id uuid references workflow_runs (id),
  created_at timestamptz not null default now(),
  constraint schedule_triggers_unique_key unique (schedule_id, scheduled_for),
  constraint schedule_triggers_outcome_check
    check (outcome in ('STARTED', 'SKIPPED', 'BUFFERED'))
);

alter table workflow_runs add column schedule_id uuid references schedules (id);
create index workflow_runs_schedule_id_idx on workflow_runs (schedule_id) where schedule_id is not null;
