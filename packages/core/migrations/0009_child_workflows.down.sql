drop index if exists workflow_runs_parent_run_id_idx;
drop index if exists workflow_runs_parent_child_key;
alter table workflow_runs drop constraint if exists workflow_runs_parent_close_policy_check;
alter table workflow_runs drop column if exists parent_close_policy;
alter table workflow_runs drop column if exists parent_child_id;
