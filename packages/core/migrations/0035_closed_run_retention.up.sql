create table namespace_retention (
  namespace_id uuid primary key references namespaces (id) on delete cascade,
  closed_run_retention_ms bigint check (closed_run_retention_ms is null or closed_run_retention_ms >= 0),
  updated_at timestamptz not null default now()
);

alter table workflow_runs add column purged_at timestamptz;

create index workflow_runs_purge_due_idx
  on workflow_runs (namespace_id, closed_at, id)
  where status <> 'RUNNING' and purged_at is null;

create index schedule_triggers_skipped_idx
  on schedule_triggers (schedule_id, created_at)
  where outcome = 'SKIPPED';

create index schedule_triggers_run_idx on schedule_triggers (run_id) where run_id is not null;

create index concurrency_slot_history_run_idx on concurrency_slot_history (run_id);

create function purge_closed_runs(
  p_namespace_id uuid,
  p_cutoff timestamptz,
  p_limit integer,
  p_now timestamptz
)
returns table (
  runs integer,
  workflow_task_results integer,
  step_attempts integer,
  timers integer,
  schedule_triggers integer,
  dead_letters integer,
  task_history integer,
  concurrency_slot_history integer
)
language plpgsql
set search_path from current
as $$
declare
  purged uuid[];
  removed integer;
begin
  with due as (
    select run.id from workflow_runs run
    where run.namespace_id = p_namespace_id and run.status <> 'RUNNING'
      and run.purged_at is null and run.closed_at <= p_cutoff
    order by run.closed_at, run.id
    limit p_limit
    for update skip locked
  ), marked as (
    update workflow_runs run set purged_at = p_now
    from due where run.id = due.id
    returning run.id
  )
  select coalesce(array_agg(marked.id), '{}') into purged from marked;
  runs := cardinality(purged);

  delete from workflow_task_results result where result.run_id = any(purged);
  get diagnostics removed = row_count;
  workflow_task_results := removed;

  delete from step_attempts attempt where attempt.run_id = any(purged);
  get diagnostics removed = row_count;
  step_attempts := removed;

  delete from timers timer where timer.run_id = any(purged);
  get diagnostics removed = row_count;
  timers := removed;

  delete from schedule_triggers trigger_row where trigger_row.run_id = any(purged);
  get diagnostics removed = row_count;
  schedule_triggers := removed;
  delete from schedule_triggers trigger_row
  using schedules schedule
  where schedule.id = trigger_row.schedule_id and schedule.namespace_id = p_namespace_id
    and trigger_row.outcome = 'SKIPPED' and trigger_row.created_at <= p_cutoff;
  get diagnostics removed = row_count;
  schedule_triggers := schedule_triggers + removed;

  delete from dead_letters letter
  where letter.run_id = any(purged) and letter.requeued_at is not null;
  get diagnostics removed = row_count;
  dead_letters := removed;

  delete from task_history retired where retired.run_id = any(purged);
  get diagnostics removed = row_count;
  task_history := removed;
  delete from tasks finished
  where finished.run_id = any(purged) and finished.state = 'COMPLETED'
    and not exists (select 1 from concurrency_slots slot where slot.task_id = finished.id);
  get diagnostics removed = row_count;
  task_history := task_history + removed;

  delete from concurrency_slot_history slot
  where slot.run_id = any(purged) and slot.released_seq is not null;
  get diagnostics removed = row_count;
  concurrency_slot_history := removed;

  return next;
end;
$$;
