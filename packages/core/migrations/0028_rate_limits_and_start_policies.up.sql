create table rate_limit_admissions (
  id bigserial primary key,
  bucket text not null,
  admitted_at timestamptz not null
);

create index rate_limit_admissions_bucket_idx on rate_limit_admissions (bucket, admitted_at);

create function take_rate_limit(
  p_bucket text,
  p_limit integer,
  p_period_ms bigint,
  p_now timestamptz
) returns table (allowed boolean, retry_after_ms bigint, remaining integer)
language plpgsql
set search_path from current
as $$
declare
  used integer;
  freed_at timestamptz;
  window_length interval := make_interval(secs => p_period_ms / 1000.0);
begin
  if p_limit is null or p_limit <= 0 or p_period_ms is null or p_period_ms <= 0 then
    raise exception 'a rate limit needs a positive limit and period, got % per % ms', p_limit, p_period_ms;
  end if;
  perform pg_advisory_xact_lock(hashtext('rate-limit:' || p_bucket));
  delete from rate_limit_admissions
  where bucket = p_bucket and admitted_at <= p_now - window_length;
  select count(*) into used from rate_limit_admissions where bucket = p_bucket;
  if used < p_limit then
    insert into rate_limit_admissions (bucket, admitted_at) values (p_bucket, p_now);
    return query select true, 0::bigint, p_limit - used - 1;
    return;
  end if;
  select admission.admitted_at into freed_at
  from rate_limit_admissions admission
  where admission.bucket = p_bucket
  order by admission.admitted_at, admission.id
  offset used - p_limit
  limit 1;
  return query select
    false,
    greatest(1, ceil(extract(epoch from (freed_at + window_length - p_now)) * 1000))::bigint,
    0;
end;
$$;

alter table workflow_runs add column idempotency_expires_at timestamptz;
alter table workflow_runs add column singleton_key text;

create index workflow_runs_open_singleton_idx
  on workflow_runs (namespace_id, singleton_key)
  where singleton_key is not null and status = 'RUNNING';

create table pending_starts (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null,
  namespace_id uuid not null references namespaces (id),
  kind text not null check (kind in ('debounce', 'singleton')),
  start_key text not null,
  workflow_type text not null,
  input jsonb not null,
  queue_name text not null,
  options jsonb not null default '{}'::jsonb,
  fire_at timestamptz,
  start_count integer not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check ((kind = 'debounce') = (fire_at is not null))
);

create unique index pending_starts_debounce_key_idx
  on pending_starts (namespace_id, start_key)
  where kind = 'debounce';
create index pending_starts_due_idx on pending_starts (fire_at) where kind = 'debounce';
create index pending_starts_singleton_idx
  on pending_starts (namespace_id, start_key, seq)
  where kind = 'singleton';
