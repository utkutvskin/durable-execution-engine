drop trigger audit_log_append_only on audit_log;
drop function audit_log_reject_change();
drop table audit_log;

alter table api_keys
  drop column last_used_at,
  drop column expires_at,
  drop column scope;
