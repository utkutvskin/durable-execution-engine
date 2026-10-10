drop table if exists run_snapshots;
alter table workflow_runs drop constraint if exists workflow_runs_status_check;
update workflow_runs set status = 'COMPLETED' where status = 'CONTINUED_AS_NEW';
alter table workflow_runs
  add constraint workflow_runs_status_check
  check (status in ('RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED'));
drop index if exists workflow_runs_first_run_id_idx;
drop trigger if exists workflow_runs_first_run_id on workflow_runs;
drop function if exists workflow_runs_set_first_run_id();
alter table workflow_runs drop column if exists chain_index;
alter table workflow_runs drop column if exists continued_from_run_id;
alter table workflow_runs drop column if exists first_run_id;
