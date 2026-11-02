alter table workflow_runs add column queue_name text not null default 'default';
update workflow_runs r
set queue_name = oldest.queue_name
from (
  select distinct on (run_id) run_id, queue_name
  from tasks
  order by run_id, created_at, id
) oldest
where oldest.run_id = r.id;
create index workflow_runs_open_queue_idx on workflow_runs (queue_name) where status = 'RUNNING';

alter table schedules add column queue_name text not null default 'default';
alter table schedules add column catch_up_policy text not null default 'latest_only';
alter table schedules add column catch_up_window_ms bigint;
alter table schedules add column error text;
alter table schedules
  add constraint schedules_catch_up_policy_check
  check (catch_up_policy in ('latest_only', 'all'));
alter table schedules
  add constraint schedules_catch_up_window_check
  check (catch_up_window_ms is null or catch_up_window_ms > 0);
alter table schedules drop constraint schedules_state_check;
alter table schedules
  add constraint schedules_state_check check (state in ('ACTIVE', 'PAUSED', 'ERRORED'));
drop index schedules_due_idx;
create index schedules_due_idx on schedules (queue_name, next_fire_at) where state = 'ACTIVE';
