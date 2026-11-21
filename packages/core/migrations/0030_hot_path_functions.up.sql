create function append_run_events(
  p_run_id uuid,
  p_expected_seq bigint,
  p_types text[],
  p_payloads text[],
  p_version integer
) returns table (sequence_number bigint, created_at timestamptz)
language plpgsql
set search_path from current
as $$
#variable_conflict use_column
declare
  current_seq bigint;
begin
  select greatest(
    coalesce((select max(stored.sequence_number) from run_events stored where stored.run_id = p_run_id), 0),
    coalesce((select snapshot.last_sequence_number from run_snapshots snapshot where snapshot.run_id = p_run_id), 0)
  ) into current_seq;
  if current_seq <> p_expected_seq then
    raise exception using
      errcode = 'DEE01',
      message = format('concurrent append to run "%s"', p_run_id),
      detail = current_seq::text;
  end if;
  return query
    insert into run_events (run_id, sequence_number, event_type, payload, event_version)
    select p_run_id, p_expected_seq + batch.position, batch.event_type, batch.payload::jsonb, p_version
    from unnest(p_types, p_payloads) with ordinality as batch (event_type, payload, position)
    returning run_events.sequence_number, run_events.created_at;
end;
$$;

create function record_step_result(
  p_run_id uuid,
  p_step_id text,
  p_attempt_key text,
  p_result jsonb,
  p_error jsonb,
  p_event_type text,
  p_event_payload text,
  p_version integer,
  p_task_id uuid,
  p_lease_token uuid,
  p_follow_up_queue text,
  p_follow_up_payload jsonb,
  p_now timestamptz
) returns table (
  recorded boolean,
  run_closed boolean,
  stored_result jsonb,
  stored_error jsonb,
  acked boolean
)
language plpgsql
set search_path from current
as $$
#variable_conflict use_column
declare
  run_status text;
  current_seq bigint;
  existing record;
begin
  recorded := false;
  run_closed := false;
  acked := false;
  if p_step_id is not null then
    select run.status into run_status from workflow_runs run where run.id = p_run_id for update;
    if run_status is not null and run_status <> 'RUNNING' then
      run_closed := true;
    else
      select stored.result, stored.error into existing
      from step_results stored where stored.run_id = p_run_id and stored.step_id = p_step_id;
      if found then
        stored_result := existing.result;
        stored_error := existing.error;
      else
        insert into step_results (run_id, step_id, attempt_key, result, error)
        values (p_run_id, p_step_id, p_attempt_key, p_result, p_error);
        select greatest(
          coalesce((select max(stored.sequence_number) from run_events stored where stored.run_id = p_run_id), 0),
          coalesce((select snapshot.last_sequence_number from run_snapshots snapshot where snapshot.run_id = p_run_id), 0)
        ) into current_seq;
        insert into run_events (run_id, sequence_number, event_type, payload, event_version)
        values (p_run_id, current_seq + 1, p_event_type, p_event_payload::jsonb, p_version);
        recorded := true;
      end if;
    end if;
  end if;
  if p_follow_up_queue is not null and not run_closed then
    insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
    select run.namespace_id, run.id, p_follow_up_queue, 'WORKFLOW_TASK', p_follow_up_payload,
           coalesce(p_now, now())
    from workflow_runs run where run.id = p_run_id;
  end if;
  if p_task_id is not null then
    update tasks
    set state = 'COMPLETED', lease_token = null, leased_by = null, leased_by_version = null,
        updated_at = coalesce(p_now, now())
    where tasks.id = p_task_id and tasks.lease_token = p_lease_token and tasks.state = 'LEASED';
    acked := found;
  end if;
  return next;
end;
$$;

create function record_workflow_task(
  p_run_id uuid,
  p_task_key text,
  p_expected_seq bigint,
  p_types text[],
  p_payloads text[],
  p_version integer,
  p_read_projection boolean
) returns table (
  outcome text,
  first_sequence_number bigint,
  last_sequence_number bigint,
  traceparent text,
  namespace_id uuid,
  run_status text,
  run_input jsonb,
  run_result jsonb,
  run_error jsonb,
  run_closed_at timestamptz,
  projected_sequence_number bigint,
  unfolded_sequence_numbers bigint[],
  unfolded_payloads text[],
  unfolded_versions integer[],
  unfolded_created_at timestamptz[]
)
language plpgsql
set search_path from current
as $$
#variable_conflict use_column
declare
  parent_id uuid;
  current_seq bigint;
  previous record;
  event_count integer := coalesce(array_length(p_types, 1), 0);
begin
  select run.parent_run_id into parent_id from workflow_runs run where run.id = p_run_id;
  if parent_id is not null then
    perform 1 from workflow_runs parent where parent.id = parent_id for update;
  end if;
  select run.status, run.traceparent, run.namespace_id
  into run_status, traceparent, namespace_id
  from workflow_runs run where run.id = p_run_id for update;
  select result.first_sequence_number as first, result.last_sequence_number as last
  into previous
  from workflow_task_results result
  where result.run_id = p_run_id and result.task_key = p_task_key;
  if found then
    outcome := 'duplicate';
    first_sequence_number := previous.first;
    last_sequence_number := previous.last;
    return next;
    return;
  end if;
  if run_status is not null and run_status <> 'RUNNING' then
    outcome := 'closed';
    first_sequence_number := p_expected_seq + 1;
    last_sequence_number := p_expected_seq;
    return next;
    return;
  end if;
  select greatest(
    coalesce((select max(stored.sequence_number) from run_events stored where stored.run_id = p_run_id), 0),
    coalesce((select snapshot.last_sequence_number from run_snapshots snapshot where snapshot.run_id = p_run_id), 0)
  ) into current_seq;
  if current_seq <> p_expected_seq then
    raise exception using
      errcode = 'DEE01',
      message = format('concurrent append to run "%s"', p_run_id),
      detail = current_seq::text;
  end if;
  if event_count > 0 then
    insert into run_events (run_id, sequence_number, event_type, payload, event_version)
    select p_run_id, p_expected_seq + batch.position, batch.event_type, batch.payload::jsonb, p_version
    from unnest(p_types, p_payloads) with ordinality as batch (event_type, payload, position);
  end if;
  insert into workflow_task_results (run_id, task_key, first_sequence_number, last_sequence_number)
  values (p_run_id, p_task_key, p_expected_seq + 1, p_expected_seq + event_count);
  outcome := 'recorded';
  first_sequence_number := p_expected_seq + 1;
  last_sequence_number := p_expected_seq + event_count;
  if p_read_projection then
    select run.status, run.input, run.result, run.error, run.closed_at, run.last_sequence_number
    into run_status, run_input, run_result, run_error, run_closed_at, projected_sequence_number
    from workflow_runs run where run.id = p_run_id;
    select array_agg(stored.sequence_number order by stored.sequence_number),
           array_agg(stored.payload::text order by stored.sequence_number),
           array_agg(stored.event_version order by stored.sequence_number),
           array_agg(stored.created_at order by stored.sequence_number)
    into unfolded_sequence_numbers, unfolded_payloads, unfolded_versions, unfolded_created_at
    from run_events stored
    where stored.run_id = p_run_id and stored.sequence_number > projected_sequence_number;
  end if;
  return next;
end;
$$;

create function close_run(
  p_run_id uuid,
  p_status text,
  p_input jsonb,
  p_result jsonb,
  p_error jsonb,
  p_closed_at timestamptz,
  p_last_sequence_number bigint
) returns table (parent_linked boolean, open_children boolean)
language plpgsql
set search_path from current
as $$
#variable_conflict use_column
begin
  update workflow_runs
  set status = p_status, input = p_input, result = p_result, error = p_error,
      closed_at = p_closed_at, last_sequence_number = p_last_sequence_number, updated_at = now()
  where id = p_run_id;
  parent_linked := false;
  open_children := false;
  if p_status <> 'RUNNING' then
    update tasks set state = 'COMPLETED', updated_at = now()
    where run_id = p_run_id and state = 'PENDING';
    parent_linked := exists (
      select 1 from workflow_runs run join workflow_runs head on head.id = run.first_run_id
      where run.id = p_run_id and run.parent_run_id is not null
        and coalesce(run.parent_child_id, head.parent_child_id) is not null
    );
    open_children := exists (
      select 1 from workflow_runs child
      where child.parent_run_id = p_run_id and child.status = 'RUNNING'
    );
  end if;
  return next;
end;
$$;

create function insert_run(
  p_namespace_id uuid,
  p_workflow_type text,
  p_input jsonb,
  p_idempotency_key text,
  p_queue_name text,
  p_search_attributes jsonb,
  p_memo jsonb,
  p_priority integer,
  p_run_id uuid,
  p_singleton_key text,
  p_idempotency_expires_at timestamptz,
  p_started_payload text,
  p_version integer,
  p_task_payload jsonb,
  p_traceparent text
) returns table (id uuid, started_at timestamptz)
language plpgsql
set search_path from current
as $$
#variable_conflict use_column
begin
  insert into workflow_runs
    (id, namespace_id, workflow_type, input, idempotency_key, queue_name, search_attributes,
     memo, priority, singleton_key, idempotency_expires_at, traceparent)
  values (coalesce(p_run_id, gen_random_uuid()), p_namespace_id, p_workflow_type, p_input,
          p_idempotency_key, p_queue_name, p_search_attributes, p_memo, p_priority,
          p_singleton_key, p_idempotency_expires_at, p_traceparent)
  on conflict (namespace_id, idempotency_key) where idempotency_key is not null
  do nothing
  returning workflow_runs.id, workflow_runs.started_at into id, started_at;
  if id is null then
    return;
  end if;
  insert into run_events (run_id, sequence_number, event_type, payload, event_version)
  values (id, 1, 'run_started', p_started_payload::jsonb, p_version);
  insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
  values (p_namespace_id, id, p_queue_name, 'WORKFLOW_TASK', p_task_payload);
  return next;
end;
$$;
