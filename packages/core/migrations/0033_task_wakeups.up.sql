create function tasks_notify_wakeup() returns trigger
language plpgsql
set search_path from current
as $$
begin
  perform pg_notify(
    'dee_wakeup',
    json_build_object('schema', tg_table_schema, 'queue', queues.queue_name)::text
  )
  from (select distinct inserted.queue_name from inserted) queues;
  return null;
end;
$$;

create trigger tasks_notify_wakeup
  after insert on tasks
  referencing new table as inserted
  for each statement
  when (current_setting('dee.notify_wakeups', true) = 'on')
  execute function tasks_notify_wakeup();
