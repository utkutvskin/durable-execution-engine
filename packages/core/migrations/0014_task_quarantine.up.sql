alter table tasks drop constraint tasks_state_check;
alter table tasks
  add constraint tasks_state_check
  check (state in ('PENDING', 'LEASED', 'COMPLETED', 'QUARANTINED'));
alter table tasks add column quarantined_at timestamptz;
alter table tasks add column quarantine_reason text;
create index tasks_quarantined_idx on tasks (namespace_id, quarantined_at) where state = 'QUARANTINED';
