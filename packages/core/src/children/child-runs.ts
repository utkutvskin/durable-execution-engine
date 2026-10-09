import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.js";
import { appendEventsOnClient } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";

/**
 * Creates the run for a `child_started` event inside the caller's
 * transaction: the `workflow_runs` row linked to its parent, the child's
 * `run_started` event and its first workflow task. Starting the same
 * `childId` of the same parent twice creates nothing and returns the run
 * that already exists. The caller must hold the parent's row lock.
 */
export async function createChildRunOnClient(
  client: PoolClient,
  codec: Codec,
  parent: { readonly runId: string; readonly namespaceId: string; readonly queueName: string },
  event: Extract<WorkflowEvent, { type: "child_started" }>,
): Promise<{ readonly runId: string; readonly created: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `insert into workflow_runs
       (namespace_id, workflow_type, input, parent_run_id, parent_child_id, parent_close_policy)
     values ($1, $2, $3::jsonb, $4, $5, $6)
     on conflict (parent_run_id, parent_child_id) where parent_child_id is not null do nothing
     returning id`,
    [
      parent.namespaceId,
      event.workflowType,
      JSON.stringify(event.input ?? {}),
      parent.runId,
      event.childId,
      event.parentClosePolicy,
    ],
  );
  const created = inserted.rows[0];
  if (created === undefined) {
    const existing = await client.query<{ id: string }>(
      "select id from workflow_runs where parent_run_id = $1 and parent_child_id = $2",
      [parent.runId, event.childId],
    );
    return { runId: existing.rows[0]?.id ?? "", created: false };
  }
  await appendEventsOnClient(client, codec, created.id, 0, [
    { type: "run_started", workflowType: event.workflowType, input: event.input },
  ]);
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [
      parent.namespaceId,
      created.id,
      parent.queueName,
      JSON.stringify({
        reason: "child_started",
        parentRunId: parent.runId,
        childId: event.childId,
      }),
    ],
  );
  return { runId: created.id, created: true };
}
