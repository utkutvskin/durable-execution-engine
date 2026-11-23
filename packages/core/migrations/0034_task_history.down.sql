drop view if exists all_tasks;
drop function if exists retire_finished_tasks(timestamptz, integer);
drop index if exists tasks_finished_idx;

insert into tasks
  (id, namespace_id, run_id, queue_name, task_type, state, payload, attempts, reclaim_count,
   priority, lease_seq, created_at, updated_at, visible_at)
select id, namespace_id, run_id, queue_name, task_type, 'COMPLETED', payload, attempts,
       reclaim_count, priority, lease_seq, created_at, completed_at, completed_at
from task_history;

drop table if exists task_history;
drop function if exists task_history_reject_update();
