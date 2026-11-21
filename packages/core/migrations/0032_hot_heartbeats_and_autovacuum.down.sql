alter table run_stickiness reset (
  fillfactor, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
  autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay
);

alter table timers reset (
  fillfactor, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
  autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay
);

alter table tasks reset (
  fillfactor, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
  autovacuum_vacuum_insert_scale_factor, autovacuum_analyze_scale_factor,
  autovacuum_vacuum_cost_delay
);

create or replace function tasks_follow_step_lease() returns trigger
language plpgsql
set search_path from current
as $$
begin
  update concurrency_slots set expires_at = new.visible_at
  where scope = 'step' and lease_token = new.lease_token;
  return null;
end;
$$;

drop trigger tasks_follow_step_lease on tasks;

create trigger tasks_follow_step_lease
  after update of visible_at on tasks
  for each row
  when (
    new.step_concurrency_key is not null and new.state = 'LEASED'
    and old.lease_token = new.lease_token
  )
  execute function tasks_follow_step_lease();

alter table tasks drop column if exists lease_extended_until;
