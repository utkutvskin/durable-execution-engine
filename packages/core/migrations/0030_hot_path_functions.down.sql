drop function if exists insert_run(uuid, text, jsonb, text, text, jsonb, jsonb, integer, uuid, text, timestamptz, text, integer, jsonb, text);
drop function if exists close_run(uuid, text, jsonb, jsonb, jsonb, timestamptz, bigint);
drop function if exists record_workflow_task(uuid, text, bigint, text[], text[], integer, boolean);
drop function if exists record_step_result(uuid, text, text, jsonb, jsonb, text, text, integer, uuid, uuid, text, jsonb, timestamptz);
drop function if exists append_run_events(uuid, bigint, text[], text[], integer);
