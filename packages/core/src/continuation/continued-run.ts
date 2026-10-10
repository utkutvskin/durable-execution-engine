import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.js";
import { appendEventsOnClient } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";

interface PredecessorRow {
  namespace_id: string;
  workflow_type: string;
  parent_run_id: string | null;
  parent_close_policy: string | null;
  schedule_id: string | null;
  first_run_id: string;
  chain_index: number;
}

/**
 * Creates the next run of a chain for a `run_continued_as_new` event inside
 * the caller's transaction: a `workflow_runs` row with the same workflow
 * type, namespace, parent link and schedule as `runId`, the same
 * `first_run_id`, the next `chain_index` and the event's input, plus its
 * `run_started` event and its first workflow task on the queue the
 * predecessor used. The caller must hold the predecessor's row lock (and its
 * parent's first). Returns the new run's id.
 */
export async function createContinuedRunOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
  event: Extract<WorkflowEvent, { type: "run_continued_as_new" }>,
): Promise<string> {
  const predecessor = await client.query<PredecessorRow>(
    `select namespace_id, workflow_type, parent_run_id, parent_close_policy, schedule_id,
            first_run_id, chain_index
     from workflow_runs where id = $1`,
    [runId],
  );
  const row = predecessor.rows[0];
  if (row === undefined) {
    throw new Error(`workflow run "${runId}" does not exist`);
  }
  const queue = await client.query<{ queue_name: string }>(
    "select queue_name from tasks where run_id = $1 order by created_at limit 1",
    [runId],
  );
  const queueName = queue.rows[0]?.queue_name;
  if (queueName === undefined) {
    throw new Error(`workflow run "${runId}" has no task to take its queue from`);
  }
  const inserted = await client.query<{ id: string }>(
    `insert into workflow_runs
       (namespace_id, workflow_type, input, parent_run_id, parent_close_policy, schedule_id,
        first_run_id, continued_from_run_id, chain_index)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      row.namespace_id,
      row.workflow_type,
      JSON.stringify(event.input ?? {}),
      row.parent_run_id,
      row.parent_close_policy,
      row.schedule_id,
      row.first_run_id,
      runId,
      row.chain_index + 1,
    ],
  );
  const nextRunId = inserted.rows[0]?.id;
  if (nextRunId === undefined) {
    throw new Error(`continuing run "${runId}" did not return the new run id`);
  }
  await appendEventsOnClient(client, codec, nextRunId, 0, [
    { type: "run_started", workflowType: row.workflow_type, input: event.input },
  ]);
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [
      row.namespace_id,
      nextRunId,
      queueName,
      JSON.stringify({ reason: "continue_as_new", continuedFromRunId: runId }),
    ],
  );
  return nextRunId;
}
