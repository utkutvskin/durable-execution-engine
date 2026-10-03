drop index if exists tasks_leased_expiry_idx;
alter table tasks drop column if exists reclaim_count;
alter table tasks drop column if exists leased_at;
alter table tasks drop column if exists leased_by_version;
alter table tasks drop column if exists leased_by;
