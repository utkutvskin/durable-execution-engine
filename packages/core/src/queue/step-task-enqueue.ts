import type { PoolClient } from "pg";

/**
 * What `enqueueStepTaskOnClient` needs: the run, the queue and the step to
 * execute, in the shape of the `step_scheduled` event.
 */
export interface StepTaskEnqueueInput {
  readonly namespaceId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly stepId: string;
  readonly stepType: string;
  readonly input: unknown;
  readonly now: Date;
}

/**
 * Inserts the `STEP_TASK` of a scheduled step on `client`, inside the
 * caller's transaction, unless the run already has a step task for that
 * step. Resolves `true` when a task was created.
 */
export async function enqueueStepTaskOnClient(
  client: PoolClient,
  input: StepTaskEnqueueInput,
): Promise<boolean> {
  const result = await client.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
     select $1, $2, $3, 'STEP_TASK', $4::jsonb, $5
     where not exists (
       select 1 from tasks
       where run_id = $2 and task_type = 'STEP_TASK' and payload ->> 'stepId' = $6
     )`,
    [
      input.namespaceId,
      input.runId,
      input.queueName,
      JSON.stringify({ stepId: input.stepId, stepType: input.stepType, input: input.input }),
      input.now,
      input.stepId,
    ],
  );
  return result.rowCount === 1;
}
