create table run_stickiness (
  run_id uuid primary key references workflow_runs (id),
  worker_id text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index run_stickiness_worker_idx on run_stickiness (worker_id);
