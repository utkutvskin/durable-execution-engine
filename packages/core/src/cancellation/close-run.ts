import type { PoolClient } from "pg";
import type { Codec } from "../event-store/codec.js";
import { refreshProjectionOnClient } from "../run/projection-store.js";
import { isTerminalState, type RunState } from "../run/state-machine.js";

/**
 * Brings the run's projection up to date inside the caller's transaction
 * and, when the run is now terminal, withdraws every task still waiting for
 * a worker so nothing new is picked up for a closed run. Tasks a worker
 * already holds are left alone: their results are discarded by the
 * recorder. The caller must hold the run row lock. Returns the run's state.
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
  }
  return projection.state;
}
