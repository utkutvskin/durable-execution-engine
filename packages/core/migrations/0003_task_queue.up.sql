alter table tasks add column payload jsonb not null default '{}'::jsonb;
alter table tasks add column lease_token uuid;
alter table tasks
  add constraint tasks_task_type_check
  check (task_type in ('WORKFLOW_TASK', 'STEP_TASK'));
alter table tasks
  add constraint tasks_state_check
  check (state in ('PENDING', 'LEASED', 'COMPLETED'));
create index tasks_queue_dequeue_idx on tasks (queue_name, visible_at)
  where state in ('PENDING', 'LEASED');
