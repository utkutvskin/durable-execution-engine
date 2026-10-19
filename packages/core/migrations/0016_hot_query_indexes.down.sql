drop index if exists tasks_open_run_idx;
drop index if exists workflow_runs_open_idx;
create index tasks_queue_dequeue_idx on tasks (queue_name, visible_at)
  where state in ('PENDING', 'LEASED');
drop index if exists tasks_queue_order_idx;
