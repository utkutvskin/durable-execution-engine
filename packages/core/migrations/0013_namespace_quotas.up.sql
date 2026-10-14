create table namespace_quotas (
  namespace_id uuid primary key references namespaces (id),
  max_concurrent_runs integer check (max_concurrent_runs is null or max_concurrent_runs >= 0),
  max_pending_tasks integer check (max_pending_tasks is null or max_pending_tasks >= 0),
  rate_per_second double precision check (rate_per_second is null or rate_per_second > 0),
  burst integer check (burst is null or burst > 0),
  updated_at timestamptz not null default now()
);
