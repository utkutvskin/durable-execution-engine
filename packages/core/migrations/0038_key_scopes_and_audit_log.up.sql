alter table api_keys
  add column scope text not null default 'admin' check (scope in ('read', 'operate', 'admin')),
  add column expires_at timestamptz,
  add column last_used_at timestamptz;

alter table api_keys alter column scope drop default;

create table audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_key_id uuid not null,
  actor_label text not null,
  actor_namespace text not null,
  actor_scope text not null,
  namespace text,
  action text not null,
  target text,
  details jsonb not null default '{}'::jsonb
);

create index audit_log_namespace_idx on audit_log (namespace, id desc);

create function audit_log_reject_change() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only' using errcode = '55000';
end;
$$;

create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function audit_log_reject_change();
