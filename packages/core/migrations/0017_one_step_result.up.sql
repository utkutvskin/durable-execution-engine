delete from step_results duplicate
using step_results first
where duplicate.run_id = first.run_id
  and duplicate.step_id = first.step_id
  and duplicate.id > first.id;

create unique index step_results_run_id_step_id_key on step_results (run_id, step_id);
