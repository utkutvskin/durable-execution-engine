alter table workflow_runs drop constraint if exists workflow_runs_run_timeout_check;
alter table workflow_runs drop column if exists execution_deadline;
alter table workflow_runs drop column if exists run_timeout_ms;
