drop index if exists workflow_runs_namespace_started_idx;
drop index if exists workflow_runs_idempotency_key_idx;
alter table workflow_runs drop column if exists idempotency_key;
drop table if exists api_keys;
