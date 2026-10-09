alter table workflow_runs add column parent_child_id text;
alter table workflow_runs add column parent_close_policy text;
alter table workflow_runs add constraint workflow_runs_parent_close_policy_check
  check (parent_close_policy in ('cancel', 'terminate', 'abandon'));

create unique index workflow_runs_parent_child_key
  on workflow_runs (parent_run_id, parent_child_id) where parent_child_id is not null;
create index workflow_runs_parent_run_id_idx
  on workflow_runs (parent_run_id) where parent_run_id is not null;
