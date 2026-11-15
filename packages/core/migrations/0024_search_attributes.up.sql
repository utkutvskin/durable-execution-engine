alter table workflow_runs add column search_attributes jsonb not null default '{}'::jsonb;
alter table workflow_runs add column memo jsonb;
alter table workflow_runs
  add constraint workflow_runs_search_attributes_check
  check (jsonb_typeof(search_attributes) = 'object');
create index workflow_runs_search_attributes_idx
  on workflow_runs using gin (search_attributes jsonb_path_ops);
create index workflow_runs_namespace_status_started_idx
  on workflow_runs (namespace_id, status, started_at desc, id desc);
