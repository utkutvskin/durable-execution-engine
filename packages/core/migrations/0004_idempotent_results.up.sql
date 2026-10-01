alter table step_results add column attempt_key text not null default 'default';
alter table step_results
  add constraint step_results_run_id_step_id_attempt_key_key
  unique (run_id, step_id, attempt_key);

create table workflow_task_results (
  id bigserial primary key,
  run_id uuid not null references workflow_runs (id),
  task_key text not null,
  first_sequence_number bigint not null,
  last_sequence_number bigint not null,
  created_at timestamptz not null default now(),
  constraint workflow_task_results_run_id_task_key_key unique (run_id, task_key)
);
