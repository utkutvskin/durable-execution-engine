alter table tasks add column leased_by text;
alter table tasks add column leased_by_version text;
alter table tasks add column leased_at timestamptz;
alter table tasks add column reclaim_count integer not null default 0;
create index tasks_leased_expiry_idx on tasks (visible_at) where state = 'LEASED';
