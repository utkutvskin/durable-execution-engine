alter table workflow_runs add column concurrency_key text;
alter table workflow_runs add column concurrency_limit integer;
alter table workflow_runs
  add constraint workflow_runs_concurrency_check
  check ((concurrency_key is null) = (concurrency_limit is null) and concurrency_limit > 0);

alter table tasks add column concurrency_key text;
alter table tasks add column concurrency_limit integer;
alter table tasks add column step_concurrency_key text;
alter table tasks add column step_concurrency_limit integer;
alter table tasks
  add constraint tasks_concurrency_check
  check ((concurrency_key is null) = (concurrency_limit is null) and concurrency_limit > 0);
alter table tasks
  add constraint tasks_step_concurrency_check
  check (
    (step_concurrency_key is null) = (step_concurrency_limit is null)
    and step_concurrency_limit > 0
  );

create table concurrency_slots (
  namespace_id uuid not null references namespaces (id),
  scope text not null check (scope in ('run', 'step')),
  concurrency_key text not null,
  slot integer not null check (slot >= 0),
  slot_limit integer not null check (slot < slot_limit),
  run_id uuid not null references workflow_runs (id),
  task_id uuid references tasks (id),
  lease_token uuid,
  expires_at timestamptz,
  acquired_at timestamptz not null,
  primary key (namespace_id, scope, concurrency_key, slot),
  check ((scope = 'step') = (task_id is not null and lease_token is not null and expires_at is not null))
);

create index concurrency_slots_run_idx on concurrency_slots (run_id) where scope = 'run';
create index concurrency_slots_lease_idx on concurrency_slots (lease_token) where scope = 'step';

create sequence concurrency_slot_seq;

create table concurrency_slot_history (
  id bigserial primary key,
  namespace_id uuid not null references namespaces (id),
  scope text not null,
  concurrency_key text not null,
  slot integer not null,
  slot_limit integer not null,
  run_id uuid not null references workflow_runs (id),
  task_id uuid,
  acquired_seq bigint not null,
  released_seq bigint
);

create index concurrency_slot_history_key_idx
  on concurrency_slot_history (namespace_id, scope, concurrency_key, acquired_seq);
create unique index concurrency_slot_history_open_idx
  on concurrency_slot_history (namespace_id, scope, concurrency_key, slot)
  where released_seq is null;

create function concurrency_slots_record_history() returns trigger
language plpgsql
set search_path from current
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update concurrency_slot_history
    set released_seq = nextval('concurrency_slot_seq')
    where namespace_id = old.namespace_id and scope = old.scope
      and concurrency_key = old.concurrency_key and slot = old.slot and released_seq is null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into concurrency_slot_history
      (namespace_id, scope, concurrency_key, slot, slot_limit, run_id, task_id, acquired_seq)
    values
      (new.namespace_id, new.scope, new.concurrency_key, new.slot, new.slot_limit, new.run_id,
       new.task_id, nextval('concurrency_slot_seq'));
  end if;
  return null;
end;
$$;

create trigger concurrency_slots_record_history
  after insert or update or delete on concurrency_slots
  for each row execute function concurrency_slots_record_history();

create function tasks_release_concurrency_slots() returns trigger
language plpgsql
set search_path from current
as $$
begin
  if old.step_concurrency_key is not null and old.state = 'LEASED'
     and old.lease_token is distinct from new.lease_token then
    delete from concurrency_slots where scope = 'step' and lease_token = old.lease_token;
  end if;
  if old.concurrency_key is not null and old.state in ('PENDING', 'LEASED')
     and new.state not in ('PENDING', 'LEASED') then
    perform pg_advisory_xact_lock(hashtext('concurrency-run:' || old.run_id::text));
    if not exists (
      select 1 from tasks open_task
      where open_task.run_id = old.run_id and open_task.id <> old.id
        and open_task.state in ('PENDING', 'LEASED')
    ) then
      delete from concurrency_slots where scope = 'run' and run_id = old.run_id;
    end if;
  end if;
  return null;
end;
$$;

create trigger tasks_release_concurrency_slots
  after update of state, lease_token on tasks
  for each row
  when (old.concurrency_key is not null or old.step_concurrency_key is not null)
  execute function tasks_release_concurrency_slots();

create function tasks_follow_step_lease() returns trigger
language plpgsql
set search_path from current
as $$
begin
  update concurrency_slots set expires_at = new.visible_at
  where scope = 'step' and lease_token = new.lease_token;
  return null;
end;
$$;

create trigger tasks_follow_step_lease
  after update of visible_at on tasks
  for each row
  when (
    new.step_concurrency_key is not null and new.state = 'LEASED'
    and old.lease_token = new.lease_token
  )
  execute function tasks_follow_step_lease();

create or replace function tasks_inherit_run_priority() returns trigger
language plpgsql
set search_path from current
as $$
begin
  select coalesce(run.priority, 0), run.concurrency_key, run.concurrency_limit
  into new.priority, new.concurrency_key, new.concurrency_limit
  from (select 1) one
  left join workflow_runs run on run.id = new.run_id;
  return new;
end;
$$;
