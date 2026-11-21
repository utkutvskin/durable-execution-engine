update tasks set state = 'COMPLETED', updated_at = now()
where id in (
  select ranked.id from (
    select id, row_number() over (
      partition by run_id order by visible_at, created_at, id
    ) as rank
    from tasks
    where task_type = 'WORKFLOW_TASK' and state = 'PENDING'
  ) ranked
  where ranked.rank > 1
);

create unique index tasks_one_pending_workflow_task_idx
  on tasks (run_id)
  where task_type = 'WORKFLOW_TASK' and state = 'PENDING';

create function tasks_merge_pending_workflow_task() returns trigger
language plpgsql
set search_path from current
as $$
declare
  pending record;
begin
  perform 1 from workflow_runs run where run.id = new.run_id for no key update;
  select waiting.id, waiting.attempts, waiting.created_at, waiting.visible_at, waiting.priority,
         waiting.concurrency_key, waiting.concurrency_limit
  into pending
  from tasks waiting
  where waiting.run_id = new.run_id and waiting.task_type = 'WORKFLOW_TASK'
    and waiting.state = 'PENDING' and waiting.id <> new.id
  for update;
  if not found then
    return new;
  end if;
  if pending.attempts = 0 or (tg_op = 'UPDATE' and pending.created_at >= new.created_at) then
    update tasks
    set visible_at = least(pending.visible_at, new.visible_at),
        priority = greatest(pending.priority, new.priority),
        concurrency_key = coalesce(pending.concurrency_key, new.concurrency_key),
        concurrency_limit = coalesce(pending.concurrency_limit, new.concurrency_limit)
    where id = pending.id;
    if tg_op = 'INSERT' then
      return null;
    end if;
    new.state := 'COMPLETED';
    new.lease_token := null;
    new.leased_by := null;
    new.leased_by_version := null;
    return new;
  end if;
  update tasks set state = 'COMPLETED', updated_at = new.updated_at where id = pending.id;
  new.visible_at := least(pending.visible_at, new.visible_at);
  new.priority := greatest(pending.priority, new.priority);
  new.concurrency_key := coalesce(new.concurrency_key, pending.concurrency_key);
  new.concurrency_limit := coalesce(new.concurrency_limit, pending.concurrency_limit);
  return new;
end;
$$;

create trigger tasks_merge_pending_workflow_task_insert
  before insert on tasks
  for each row
  when (new.task_type = 'WORKFLOW_TASK' and new.state = 'PENDING')
  execute function tasks_merge_pending_workflow_task();

create trigger tasks_merge_pending_workflow_task_update
  before update of state on tasks
  for each row
  when (new.task_type = 'WORKFLOW_TASK' and new.state = 'PENDING' and old.state <> 'PENDING')
  execute function tasks_merge_pending_workflow_task();
