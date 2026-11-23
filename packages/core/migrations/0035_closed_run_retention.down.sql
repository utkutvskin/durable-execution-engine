drop function if exists purge_closed_runs(uuid, timestamptz, integer, timestamptz);
drop index if exists concurrency_slot_history_run_idx;
drop index if exists schedule_triggers_run_idx;
drop index if exists schedule_triggers_skipped_idx;
drop index if exists workflow_runs_purge_due_idx;
alter table workflow_runs drop column if exists purged_at;
drop table if exists namespace_retention;
