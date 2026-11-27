drop table batch_operation_targets;
drop table batch_operations;

drop index workflow_runs_reset_from_idx;

alter table workflow_runs
  drop constraint workflow_runs_reset_link_check,
  drop column reset_kind,
  drop column reset_event_sequence,
  drop column reset_from_run_id;
