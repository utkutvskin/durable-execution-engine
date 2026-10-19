create index tasks_queue_order_idx on tasks (queue_name, visible_at, created_at, id)
  where state in ('PENDING', 'LEASED');
drop index tasks_queue_dequeue_idx;
create index workflow_runs_open_idx on workflow_runs (created_at, id) where status = 'RUNNING';
create index tasks_open_run_idx on tasks (run_id) where state in ('PENDING', 'LEASED', 'QUARANTINED');
