alter table run_events drop constraint if exists run_events_event_version_check;
alter table run_events drop column if exists event_version;
