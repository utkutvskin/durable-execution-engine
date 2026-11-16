create table step_heartbeats (
  run_id uuid not null references workflow_runs (id) on delete cascade,
  step_id text not null,
  attempt integer not null,
  details jsonb,
  recorded_at timestamptz not null,
  constraint step_heartbeats_pkey primary key (run_id, step_id),
  constraint step_heartbeats_attempt_check check (attempt > 0)
);
