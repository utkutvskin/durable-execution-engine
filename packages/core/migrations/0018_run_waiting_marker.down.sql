alter table workflow_runs drop constraint if exists workflow_runs_waiting_on_check;
alter table workflow_runs drop column if exists last_recovered_at;
alter table workflow_runs drop column if exists recovery_count;
alter table workflow_runs drop column if exists waiting_on;
