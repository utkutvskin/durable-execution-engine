create table namespaces (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id),
  workflow_type text not null,
  status text not null default 'RUNNING',
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  parent_run_id uuid references workflow_runs (id),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workflow_runs_namespace_id_idx on workflow_runs (namespace_id);

create table run_events (
  id bigserial primary key,
  run_id uuid not null references workflow_runs (id),
  sequence_number bigint not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint run_events_run_id_sequence_number_key unique (run_id, sequence_number)
);

create index run_events_run_id_idx on run_events (run_id);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id),
  run_id uuid not null references workflow_runs (id),
  queue_name text not null,
  task_type text not null,
  state text not null default 'PENDING',
  visible_at timestamptz not null default now(),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_run_id_idx on tasks (run_id);
create index tasks_state_visible_at_idx on tasks (state, visible_at) where state = 'PENDING';

create table timers (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references workflow_runs (id),
  timer_id text not null,
  fire_at timestamptz not null,
  state text not null default 'PENDING',
  created_at timestamptz not null default now()
);

create index timers_run_id_idx on timers (run_id);

create table step_results (
  id bigserial primary key,
  run_id uuid not null references workflow_runs (id),
  step_id text not null,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now()
);

create index step_results_run_id_idx on step_results (run_id);
