alter table workflow_runs add column error jsonb;
alter table workflow_runs add column last_sequence_number bigint not null default 0;
alter table workflow_runs
  add constraint workflow_runs_status_check
  check (status in ('RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED'));
