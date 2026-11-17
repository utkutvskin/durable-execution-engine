alter table workflow_runs add column priority integer not null default 0;
alter table workflow_runs
  add constraint workflow_runs_priority_check check (priority between -1000 and 1000);

alter table tasks add column priority integer not null default 0;
alter table tasks add column lease_seq bigint;

create sequence task_lease_seq;

create function tasks_inherit_run_priority() returns trigger
language plpgsql
set search_path from current
as $$
begin
  new.priority := coalesce((select priority from workflow_runs where id = new.run_id), 0);
  return new;
end;
$$;

create trigger tasks_inherit_run_priority
  before insert on tasks
  for each row execute function tasks_inherit_run_priority();

create index tasks_fair_dequeue_idx
  on tasks (queue_name, namespace_id, task_type, priority desc, visible_at, created_at, id)
  where state in ('PENDING', 'LEASED');

create index tasks_lane_turn_idx on tasks (queue_name, namespace_id, task_type, lease_seq)
  where lease_seq is not null;
