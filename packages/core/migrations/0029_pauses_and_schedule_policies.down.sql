update schedules set overlap_policy = 'buffer_one' where overlap_policy = 'cancel_other';
alter table schedules drop constraint schedules_overlap_policy_check;
alter table schedules add constraint schedules_overlap_policy_check
  check (overlap_policy in ('skip', 'buffer_one', 'allow_all'));
drop table if exists pauses;
