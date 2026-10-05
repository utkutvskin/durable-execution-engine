drop index if exists timers_due_idx;
alter table timers drop constraint if exists timers_run_id_timer_id_key;
alter table timers drop constraint if exists timers_state_check;
alter table timers drop column if exists fired_at;
