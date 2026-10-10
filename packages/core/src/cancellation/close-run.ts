import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.js";
import { appendEventsOnClient, readCurrentSequenceOnClient } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { refreshProjectionOnClient } from "../run/projection-store.js";
import type { RunProjection } from "../run/projection.js";
import { isTerminalState, type RunState } from "../run/state-machine.js";
import { requestCancellationOnClient } from "./request-cancellation.js";

interface ChildLink {
  parent_run_id: string | null;
  parent_child_id: string | null;
}

async function queueNameOf(client: PoolClient, runId: string): Promise<string> {
  const task = await client.query<{ queue_name: string }>(
    "select queue_name from tasks where run_id = $1 order by created_at limit 1",
    [runId],
  );
  const queueName = task.rows[0]?.queue_name;
  if (queueName === undefined) {
    throw new Error(`workflow run "${runId}" has no task to take its queue from`);
  }
  return queueName;
}

function childOutcomeEvent(
  childId: string,
  state: RunState,
  projection: RunProjection,
): WorkflowEvent {
  switch (state) {
    case "COMPLETED":
      return { type: "child_completed", childId, result: projection.result };
    case "FAILED":
      return {
        type: "child_failed",
        childId,
        error: projection.error ?? { name: "Error", message: "child workflow failed" },
      };
    case "TIMED_OUT":
      return {
        type: "child_failed",
        childId,
        error: { name: "TimedOutError", message: "child workflow timed out" },
      };
    case "CANCELLED":
      return {
        type: "child_failed",
        childId,
        error: { name: "CancelledError", message: "child workflow was cancelled" },
      };
    default:
      return {
        type: "child_failed",
        childId,
        error: { name: "TerminatedError", message: "child workflow was terminated" },
      };
  }
}

async function notifyParent(
  client: PoolClient,
  codec: Codec,
  runId: string,
  projection: RunProjection,
): Promise<void> {
  if (projection.state === "CONTINUED_AS_NEW") {
    return;
  }
  const link = await client.query<ChildLink>(
    `select run.parent_run_id, coalesce(run.parent_child_id, head.parent_child_id) as parent_child_id
     from workflow_runs run join workflow_runs head on head.id = run.first_run_id
     where run.id = $1`,
    [runId],
  );
  const parentRunId = link.rows[0]?.parent_run_id;
  const childId = link.rows[0]?.parent_child_id;
  if (
    parentRunId === undefined ||
    parentRunId === null ||
    childId === undefined ||
    childId === null
  ) {
    return;
  }
  const parent = await client.query<{ status: string; namespace_id: string }>(
    "select status, namespace_id from workflow_runs where id = $1 for update",
    [parentRunId],
  );
  const parentRow = parent.rows[0];
  if (parentRow?.status !== "RUNNING") {
    return;
  }
  const currentSeq = await readCurrentSequenceOnClient(client, parentRunId);
  await appendEventsOnClient(client, codec, parentRunId, currentSeq, [
    childOutcomeEvent(childId, projection.state, projection),
  ]);
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [
      parentRow.namespace_id,
      parentRunId,
      await queueNameOf(client, runId),
      JSON.stringify({ reason: "child_closed", childId }),
    ],
  );
}

interface OpenChildRow {
  id: string;
  namespace_id: string;
  parent_close_policy: string | null;
}

async function applyParentClosePolicies(
  client: PoolClient,
  codec: Codec,
  parentRunId: string,
): Promise<void> {
  const children = await client.query<OpenChildRow>(
    `select id, namespace_id, parent_close_policy from workflow_runs
     where parent_run_id = $1 and status = 'RUNNING'
     order by id for update`,
    [parentRunId],
  );
  for (const child of children.rows) {
    if (child.parent_close_policy === "cancel") {
      await requestCancellationOnClient(
        client,
        codec,
        {
          runId: child.id,
          namespaceId: child.namespace_id,
          queueName: await queueNameOf(client, child.id),
        },
        "parent run closed",
      );
    } else if (child.parent_close_policy === "terminate") {
      const currentSeq = await readCurrentSequenceOnClient(client, child.id);
      await appendEventsOnClient(client, codec, child.id, currentSeq, [
        { type: "run_terminated", reason: "parent run closed" },
      ]);
      await closeRunIfTerminal(client, codec, child.id);
    }
  }
}

/**
 * Brings the run's projection up to date inside the caller's transaction
 * and, when the run is now terminal, withdraws every task still waiting for
 * a worker so nothing new is picked up for a closed run. Tasks a worker
 * already holds are left alone: their results are discarded by the
 * recorder. A terminal child run also records its outcome in its parent's
 * history and wakes the parent, and a terminal parent applies each open
 * child's `parentClosePolicy`. The caller must hold the run row lock, and
 * its parent's first (see `lockRunWithParent`). Returns the run's state.
 */
export async function closeRunIfTerminal(
  client: PoolClient,
  codec: Codec,
  runId: string,
): Promise<RunState> {
  const projection = await refreshProjectionOnClient(client, codec, runId);
  if (isTerminalState(projection.state)) {
    await client.query(
      `update tasks set state = 'COMPLETED', updated_at = now()
       where run_id = $1 and state = 'PENDING'`,
      [runId],
    );
    await notifyParent(client, codec, runId, projection);
    await applyParentClosePolicies(client, codec, runId);
  }
  return projection.state;
}
