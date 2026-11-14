create table external_events (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id) on delete cascade,
  event_name text not null,
  correlation_key text not null,
  payload jsonb not null default 'null'::jsonb,
  received_at timestamptz not null,
  expires_at timestamptz not null,
  constraint external_events_name_check check (length(event_name) > 0),
  constraint external_events_expiry_check check (expires_at >= received_at)
);

create index external_events_lookup_idx
  on external_events (namespace_id, event_name, correlation_key, received_at);

create table event_waits (
  run_id uuid not null references workflow_runs (id) on delete cascade,
  wait_id text not null,
  namespace_id uuid not null references namespaces (id) on delete cascade,
  event_name text not null,
  correlation_key text not null,
  expires_at timestamptz,
  delivered_event_id uuid references external_events (id) on delete set null,
  delivered_at timestamptz,
  primary key (run_id, wait_id)
);

create index event_waits_open_idx
  on event_waits (namespace_id, event_name, correlation_key)
  where delivered_at is null;

create unique index event_waits_one_delivery_per_run_idx
  on event_waits (run_id, delivered_event_id)
  where delivered_event_id is not null;

create table event_triggers (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id) on delete cascade,
  event_name text not null,
  correlation_key text,
  workflow_type text not null,
  queue_name text not null default 'default',
  created_at timestamptz not null default now(),
  constraint event_triggers_name_check check (length(event_name) > 0),
  constraint event_triggers_type_check check (length(workflow_type) > 0)
);

create index event_triggers_lookup_idx on event_triggers (namespace_id, event_name);

create table signal_ids (
  first_run_id uuid not null,
  signal_id text not null,
  run_id uuid not null,
  sequence_number bigint not null,
  received_at timestamptz not null default now(),
  primary key (first_run_id, signal_id)
);
