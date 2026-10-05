alter table timers add column fired_at timestamptz;
alter table timers
  add constraint timers_state_check
  check (state in ('PENDING', 'FIRED', 'CANCELLED'));
alter table timers
  add constraint timers_run_id_timer_id_key unique (run_id, timer_id);
create index timers_due_idx on timers (fire_at, id) where state = 'PENDING';
