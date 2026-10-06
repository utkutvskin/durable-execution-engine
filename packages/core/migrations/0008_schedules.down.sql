drop index if exists workflow_runs_schedule_id_idx;
alter table workflow_runs drop column if exists schedule_id;
drop table if exists schedule_triggers;
drop table if exists schedules;
