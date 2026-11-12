alter table run_events add column event_version smallint not null default 1;
alter table run_events
  add constraint run_events_event_version_check check (event_version >= 1);
