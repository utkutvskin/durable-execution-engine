drop table if exists pending_starts;
drop index if exists workflow_runs_open_singleton_idx;
alter table workflow_runs drop column if exists singleton_key;
alter table workflow_runs drop column if exists idempotency_expires_at;
drop function if exists take_rate_limit(text, integer, bigint, timestamptz);
drop table if exists rate_limit_admissions;
