alter table workflow_runs add column run_timeout_ms bigint;
alter table workflow_runs add column execution_deadline timestamptz;
alter table workflow_runs
  add constraint workflow_runs_run_timeout_check check (run_timeout_ms is null or run_timeout_ms > 0);
