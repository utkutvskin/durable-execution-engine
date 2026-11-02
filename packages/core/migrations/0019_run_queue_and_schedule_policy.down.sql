drop index if exists schedules_due_idx;
create index schedules_due_idx on schedules (next_fire_at) where state = 'ACTIVE';
update schedules set state = 'PAUSED' where state = 'ERRORED';
alter table schedules drop constraint schedules_state_check;
alter table schedules
  add constraint schedules_state_check check (state in ('ACTIVE', 'PAUSED'));
alter table schedules drop constraint if exists schedules_catch_up_window_check;
alter table schedules drop constraint if exists schedules_catch_up_policy_check;
alter table schedules drop column if exists error;
alter table schedules drop column if exists catch_up_window_ms;
alter table schedules drop column if exists catch_up_policy;
alter table schedules drop column if exists queue_name;
drop index if exists workflow_runs_open_queue_idx;
alter table workflow_runs drop column if exists queue_name;
