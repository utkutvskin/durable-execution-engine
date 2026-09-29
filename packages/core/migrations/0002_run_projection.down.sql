alter table workflow_runs drop constraint if exists workflow_runs_status_check;
alter table workflow_runs drop column if exists last_sequence_number;
alter table workflow_runs drop column if exists error;
