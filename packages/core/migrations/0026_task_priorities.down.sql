drop index if exists tasks_lane_turn_idx;
drop index if exists tasks_fair_dequeue_idx;
drop trigger if exists tasks_inherit_run_priority on tasks;
drop function if exists tasks_inherit_run_priority();
drop sequence if exists task_lease_seq;
alter table tasks drop column if exists lease_seq;
alter table tasks drop column if exists priority;
alter table workflow_runs drop constraint if exists workflow_runs_priority_check;
alter table workflow_runs drop column if exists priority;
