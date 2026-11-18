create or replace function tasks_inherit_run_priority() returns trigger
language plpgsql
set search_path from current
as $$
begin
  new.priority := coalesce((select priority from workflow_runs where id = new.run_id), 0);
  return new;
end;
$$;

drop trigger if exists tasks_follow_step_lease on tasks;
drop function if exists tasks_follow_step_lease();
drop trigger if exists tasks_release_concurrency_slots on tasks;
drop function if exists tasks_release_concurrency_slots();
drop table if exists concurrency_slot_history;
drop table if exists concurrency_slots;
drop function if exists concurrency_slots_record_history();
drop sequence if exists concurrency_slot_seq;
alter table tasks drop constraint if exists tasks_step_concurrency_check;
alter table tasks drop constraint if exists tasks_concurrency_check;
alter table tasks drop column if exists step_concurrency_limit;
alter table tasks drop column if exists step_concurrency_key;
alter table tasks drop column if exists concurrency_limit;
alter table tasks drop column if exists concurrency_key;
alter table workflow_runs drop constraint if exists workflow_runs_concurrency_check;
alter table workflow_runs drop column if exists concurrency_limit;
alter table workflow_runs drop column if exists concurrency_key;
