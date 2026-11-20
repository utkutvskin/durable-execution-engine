create table pauses (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  namespace_id uuid not null references namespaces (id) on delete cascade,
  queue_name text,
  run_id uuid references workflow_runs (id) on delete cascade,
  reason text,
  paused_at timestamptz not null default now(),
  constraint pauses_scope_check check (scope in ('namespace', 'queue', 'run')),
  constraint pauses_queue_target_check check ((scope = 'queue') = (queue_name is not null)),
  constraint pauses_run_target_check check ((scope = 'run') = (run_id is not null))
);

create unique index pauses_namespace_idx on pauses (namespace_id) where scope = 'namespace';
create unique index pauses_queue_idx on pauses (namespace_id, queue_name) where scope = 'queue';
create unique index pauses_run_idx on pauses (run_id) where scope = 'run';

alter table schedules drop constraint schedules_overlap_policy_check;
alter table schedules add constraint schedules_overlap_policy_check
  check (overlap_policy in ('skip', 'buffer_one', 'cancel_other', 'allow_all'));
