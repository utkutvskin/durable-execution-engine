import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.js";
import {
  appendEventsOnClient,
  readCurrentSequenceOnClient,
  readEventsOnClient,
} from "../event-store/event-store.js";

/**
 * Records `cancel_requested` on `runId` and enqueues a workflow task for
 * it, inside the caller's transaction, unless a request is already
 * pending. The caller must hold the run row lock. Returns whether a request
 * was written and the sequence number of the pending request.
 */
export async function requestCancellationOnClient(
  client: PoolClient,
  codec: Codec,
  run: { readonly runId: string; readonly namespaceId: string; readonly queueName: string },
  reason?: string,
): Promise<{ readonly requested: boolean; readonly sequenceNumber: number }> {
  const history = await readEventsOnClient(client, codec, run.runId);
  const pending = history.find((stored) => stored.event.type === "cancel_requested");
  if (pending !== undefined) {
    return { requested: false, sequenceNumber: pending.sequenceNumber };
  }
  const currentSeq = await readCurrentSequenceOnClient(client, run.runId);
  const [stored] = await appendEventsOnClient(client, codec, run.runId, currentSeq, [
    reason === undefined ? { type: "cancel_requested" } : { type: "cancel_requested", reason },
  ]);
  await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
     values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
    [run.namespaceId, run.runId, run.queueName, JSON.stringify({ reason: "cancel" })],
  );
  return { requested: true, sequenceNumber: stored?.sequenceNumber ?? currentSeq + 1 };
}
