create table task_history (
  id uuid primary key,
  namespace_id uuid not null references namespaces (id) on delete cascade,
  run_id uuid not null references workflow_runs (id) on delete cascade,
  queue_name text not null,
  task_type text not null,
  payload jsonb not null,
  attempts integer not null,
  reclaim_count integer not null,
  priority integer not null,
  lease_seq bigint,
  created_at timestamptz not null,
  completed_at timestamptz not null,
  retired_at timestamptz not null default now()
);

create index task_history_run_idx on task_history (run_id);

create function task_history_reject_update() returns trigger
language plpgsql
as $$
begin
  raise exception 'task_history is append-only' using errcode = '55000';
end;
$$;

create trigger task_history_append_only
  before update on task_history
  for each row execute function task_history_reject_update();

create index tasks_finished_idx on tasks (updated_at, id) where state = 'COMPLETED';

create function retire_finished_tasks(p_before timestamptz, p_limit integer)
returns integer
language plpgsql
set search_path from current
as $$
declare
  moved integer;
begin
  with finished as (
    select t.id from tasks t
    where t.state = 'COMPLETED' and t.updated_at <= p_before
      and not exists (select 1 from concurrency_slots slot where slot.task_id = t.id)
    order by t.updated_at, t.id
    limit p_limit
    for update skip locked
  ), retired as (
    delete from tasks t using finished where t.id = finished.id
    returning t.*
  )
  insert into task_history
    (id, namespace_id, run_id, queue_name, task_type, payload, attempts, reclaim_count, priority,
     lease_seq, created_at, completed_at)
  select id, namespace_id, run_id, queue_name, task_type, payload, attempts, reclaim_count,
         priority, lease_seq, created_at, updated_at
  from retired
  on conflict (id) do nothing;
  get diagnostics moved = row_count;
  return moved;
end;
$$;

create view all_tasks as
select id, namespace_id, run_id, queue_name, task_type, state, payload, attempts, reclaim_count,
       priority, lease_seq, created_at, updated_at
from tasks
union all
select id, namespace_id, run_id, queue_name, task_type, 'COMPLETED', payload, attempts,
       reclaim_count, priority, lease_seq, created_at, completed_at
from task_history;
