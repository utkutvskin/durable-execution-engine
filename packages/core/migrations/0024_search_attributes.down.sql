drop index if exists workflow_runs_namespace_status_started_idx;
drop index if exists workflow_runs_search_attributes_idx;
alter table workflow_runs drop constraint if exists workflow_runs_search_attributes_check;
alter table workflow_runs drop column if exists memo;
alter table workflow_runs drop column if exists search_attributes;
