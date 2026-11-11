create function start_workflow(
  workflow_type text,
  input jsonb default 'null'::jsonb,
  idempotency_key text default null,
  namespace text default 'default',
  queue_name text default 'default'
) returns uuid
language plpgsql
set search_path from current
as $$
#variable_conflict use_column
declare
  found_namespace_id uuid;
  started_run_id uuid;
  existing record;
begin
  if start_workflow.workflow_type is null or start_workflow.workflow_type = '' then
    raise exception 'workflow_type must not be empty' using errcode = '22023';
  end if;

  select id into found_namespace_id from namespaces where name = start_workflow.namespace;
  if found_namespace_id is null then
    insert into namespaces (name) values (start_workflow.namespace)
    on conflict (name) do update set name = excluded.name
    returning id into found_namespace_id;
  end if;

  insert into workflow_runs (namespace_id, workflow_type, input, idempotency_key, queue_name)
  values (
    found_namespace_id,
    start_workflow.workflow_type,
    coalesce(start_workflow.input, 'null'::jsonb),
    start_workflow.idempotency_key,
    start_workflow.queue_name
  )
  on conflict (namespace_id, idempotency_key) where idempotency_key is not null
  do nothing
  returning id into started_run_id;

  if started_run_id is null then
    select id, workflow_type, input into existing
    from workflow_runs
    where namespace_id = found_namespace_id and idempotency_key = start_workflow.idempotency_key;
    if existing.workflow_type <> start_workflow.workflow_type
      or existing.input <> coalesce(start_workflow.input, 'null'::jsonb) then
      raise exception 'idempotency key "%" already started run "%" with a different workflow type or input',
        start_workflow.idempotency_key, existing.id
        using errcode = '23505';
    end if;
    return existing.id;
  end if;

  insert into run_events (run_id, sequence_number, event_type, payload)
  values (
    started_run_id,
    1,
    'run_started',
    jsonb_build_object(
      'type', 'run_started',
      'workflowType', start_workflow.workflow_type,
      'input', coalesce(start_workflow.input, 'null'::jsonb)
    )
  );

  insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
  values (
    found_namespace_id,
    started_run_id,
    start_workflow.queue_name,
    'WORKFLOW_TASK',
    '{"reason":"start"}'::jsonb
  );

  return started_run_id;
end;
$$;
