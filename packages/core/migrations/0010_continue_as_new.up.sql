alter table workflow_runs add column first_run_id uuid references workflow_runs (id);
alter table workflow_runs add column continued_from_run_id uuid references workflow_runs (id);
alter table workflow_runs add column chain_index integer not null default 0;

create function workflow_runs_set_first_run_id() returns trigger as $$
begin
  new.first_run_id := coalesce(new.first_run_id, new.id);
  return new;
end;
$$ language plpgsql;

create trigger workflow_runs_first_run_id
  before insert on workflow_runs
  for each row execute function workflow_runs_set_first_run_id();

update workflow_runs set first_run_id = id where first_run_id is null;

create index workflow_runs_first_run_id_idx on workflow_runs (first_run_id, chain_index);

alter table workflow_runs drop constraint workflow_runs_status_check;
alter table workflow_runs
  add constraint workflow_runs_status_check
  check (status in (
    'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'CONTINUED_AS_NEW'
  ));

create table run_snapshots (
  run_id uuid primary key references workflow_runs (id),
  last_sequence_number bigint not null,
  pruned_event_count bigint not null,
  projection jsonb not null,
  created_at timestamptz not null default now()
);
