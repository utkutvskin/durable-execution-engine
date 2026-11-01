alter table workflow_runs add column waiting_on text;
alter table workflow_runs add column recovery_count integer not null default 0;
alter table workflow_runs add column last_recovered_at timestamptz;
alter table workflow_runs
  add constraint workflow_runs_waiting_on_check
  check (waiting_on is null or waiting_on in ('external', 'dead_letter'));
