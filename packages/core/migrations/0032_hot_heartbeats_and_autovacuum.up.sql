alter table tasks add column lease_extended_until timestamptz;

create or replace function tasks_follow_step_lease() returns trigger
language plpgsql
set search_path from current
as $$
begin
  update concurrency_slots
  set expires_at = greatest(new.visible_at, coalesce(new.lease_extended_until, new.visible_at))
  where scope = 'step' and lease_token = new.lease_token;
  return null;
end;
$$;

drop trigger tasks_follow_step_lease on tasks;

create trigger tasks_follow_step_lease
  after update of visible_at, lease_extended_until on tasks
  for each row
  when (
    new.step_concurrency_key is not null and new.state = 'LEASED'
    and old.lease_token = new.lease_token
  )
  execute function tasks_follow_step_lease();

alter table tasks set (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 500,
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 1
);

alter table timers set (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 200,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_cost_delay = 1
);

alter table run_stickiness set (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 200,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_cost_delay = 1
);
