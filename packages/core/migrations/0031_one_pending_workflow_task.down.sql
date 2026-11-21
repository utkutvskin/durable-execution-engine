drop trigger if exists tasks_merge_pending_workflow_task_update on tasks;
drop trigger if exists tasks_merge_pending_workflow_task_insert on tasks;
drop function if exists tasks_merge_pending_workflow_task();
drop index if exists tasks_one_pending_workflow_task_idx;
