drop table if exists workflow_task_results;
alter table step_results drop constraint if exists step_results_run_id_step_id_attempt_key_key;
alter table step_results drop column if exists attempt_key;
