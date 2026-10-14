drop index if exists tasks_quarantined_idx;
update tasks set state = 'PENDING' where state = 'QUARANTINED';
alter table tasks drop column if exists quarantine_reason;
alter table tasks drop column if exists quarantined_at;
alter table tasks drop constraint tasks_state_check;
alter table tasks
  add constraint tasks_state_check
  check (state in ('PENDING', 'LEASED', 'COMPLETED'));
