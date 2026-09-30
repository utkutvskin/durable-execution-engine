drop index if exists tasks_queue_dequeue_idx;
alter table tasks drop constraint if exists tasks_state_check;
alter table tasks drop constraint if exists tasks_task_type_check;
alter table tasks drop column if exists lease_token;
alter table tasks drop column if exists payload;
