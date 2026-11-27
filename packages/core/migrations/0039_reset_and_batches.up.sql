alter table workflow_runs
  add column reset_from_run_id uuid,
  add column reset_event_sequence integer,
  add column reset_kind text check (reset_kind in ('reset', 'fork')),
  add constraint workflow_runs_reset_link_check check (
    (reset_from_run_id is null and reset_event_sequence is null and reset_kind is null)
    or (reset_from_run_id is not null and reset_event_sequence is not null and reset_kind is not null)
  );

create index workflow_runs_reset_from_idx on workflow_runs (reset_from_run_id)
  where reset_from_run_id is not null;

create table batch_operations (
  id uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces (id) on delete cascade,
  operation text not null
    check (operation in ('cancel', 'terminate', 'signal', 'reset', 'requeue')),
  query text not null,
  arguments jsonb not null default '{}'::jsonb,
  reason text,
  page_size integer not null check (page_size > 0),
  page_interval_ms integer not null check (page_interval_ms >= 0),
  run_id uuid not null,
  total integer not null check (total >= 0),
  created_at timestamptz not null default now()
);

create index batch_operations_namespace_idx on batch_operations (namespace_id, created_at desc, id);

create table batch_operation_targets (
  batch_id uuid not null references batch_operations (id) on delete cascade,
  position integer not null,
  run_id uuid not null,
  state text not null default 'PENDING' check (state in ('PENDING', 'APPLIED', 'SKIPPED')),
  detail text,
  applied_at timestamptz,
  primary key (batch_id, position)
);

create index batch_operation_targets_pending_idx on batch_operation_targets (batch_id, position)
  where state = 'PENDING';
