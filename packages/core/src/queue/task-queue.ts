import type { Pool } from "pg";
import { DEFAULT_POISON_THRESHOLD } from "../recovery/janitor.ts";
import type { ClockSource } from "../workflow/sources.ts";

/**
 * The kinds of work a queue carries: a `WORKFLOW_TASK` asks a worker to run
 * a decision, a `STEP_TASK` asks it to execute a step.
 */
export const TASK_TYPES = ["WORKFLOW_TASK", "STEP_TASK"] as const;

/**
 * One of the values of `TASK_TYPES`.
 */
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * A task as handed to a consumer. `leaseToken` identifies this particular
 * delivery: `ack`, `nack` and `extend` only act while it is still the
 * task's current lease.
 */
export interface LeasedTask {
  readonly id: string;
  readonly namespaceId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly taskType: TaskType;
  readonly payload: unknown;
  readonly attempts: number;
  readonly leaseToken: string;
  readonly visibleAt: Date;
}

/**
 * What `TaskQueue.enqueue` needs to create a task. `delayMs` postpones the
 * first delivery.
 */
export interface EnqueueInput {
  readonly namespaceId: string;
  readonly runId: string;
  readonly queueName: string;
  readonly taskType: TaskType;
  readonly payload?: unknown;
  readonly delayMs?: number;
}

/**
 * Options for `TaskQueue.dequeue`. A dequeued task stays invisible to other
 * consumers for `visibilityTimeoutMs`; if it is neither acked nor nacked by
 * then, it becomes deliverable again. `limit` defaults to 1. `workerId` and
 * `workerVersion` are stamped on every task the call leases, so a reclaim
 * can tell which worker an orphaned lease belonged to. When `stickyFor` is
 * set, workflow tasks of runs that another worker holds a live sticky claim on
 * (see `createStickyRouter`) are skipped; an expired claim no longer blocks.
 *
 * Taking a task whose lease expired counts as a reclaim. A task reclaimed
 * for the `poisonThreshold`th time is quarantined instead of delivered.
 */
export interface DequeueOptions {
  readonly queueName: string;
  readonly visibilityTimeoutMs: number;
  readonly limit?: number;
  readonly workerId?: string;
  readonly workerVersion?: string;
  readonly stickyFor?: string;
}

/**
 * A postgres-backed task queue. Dequeue uses `FOR UPDATE SKIP LOCKED`, so
 * concurrent consumers never receive the same delivery. `quarantine` parks a
 * leased task for an operator with a reason, and resolves `false` when the
 * lease is no longer current.
 */
export interface TaskQueue {
  enqueue(input: EnqueueInput): Promise<string>;
  dequeue(options: DequeueOptions): Promise<LeasedTask[]>;
  ack(taskId: string, leaseToken: string): Promise<boolean>;
  nack(taskId: string, leaseToken: string, delayMs?: number): Promise<boolean>;
  quarantine(taskId: string, leaseToken: string, reason: string): Promise<boolean>;
  extend(taskId: string, leaseToken: string, visibilityTimeoutMs: number): Promise<boolean>;
}

/**
 * Builds the queue name for a namespace, so two namespaces using the same
 * queue name never share tasks.
 */
export function taskQueueName(namespace: string, queue: string): string {
  return `${namespace}/${queue}`;
}

interface TaskRow {
  id: string;
  namespace_id: string;
  run_id: string;
  queue_name: string;
  task_type: TaskType;
  payload: unknown;
  attempts: number;
  lease_token: string;
  visible_at: Date;
}

function toLeasedTask(row: TaskRow): LeasedTask {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    runId: row.run_id,
    queueName: row.queue_name,
    taskType: row.task_type,
    payload: row.payload,
    attempts: row.attempts,
    leaseToken: row.lease_token,
    visibleAt: row.visible_at,
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

const DATABASE_NOW = "now()";

function at(placeholder: string): string {
  return `coalesce(${placeholder}::timestamptz, ${DATABASE_NOW})`;
}

/**
 * Creates a `TaskQueue` over `pool`. Without `clock`, every lease, visibility
 * and extend decision uses the database's time, so hosts whose own clocks
 * disagree still agree on who holds a lease. A `clock` replaces it, which is
 * how tests move time without waiting; production code leaves it out.
 *
 * `ack`, `nack` and `extend` resolve `true` when the given lease was still
 * current and the change applied, and `false` when it was not (the task was
 * already acked, or redelivered to another consumer after its visibility
 * timeout). `extend` also resolves `false` once the lease has expired.
 */
export function createTaskQueue(
  pool: Pool,
  options: { readonly clock?: ClockSource; readonly poisonThreshold?: number } = {},
): TaskQueue {
  const clock = options.clock;
  const instant = (): Date | null => clock?.now() ?? null;
  const poisonThreshold = options.poisonThreshold ?? DEFAULT_POISON_THRESHOLD;
  assertPositiveInteger("poisonThreshold", poisonThreshold);

  return {
    async enqueue(input: EnqueueInput): Promise<string> {
      const delayMs = input.delayMs ?? 0;
      assertNonNegativeInteger("delayMs", delayMs);
      const result = await pool.query<{ id: string }>(
        `insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
         values ($1, $2, $3, $4, $5::jsonb, ${at("$6")} + $7 * interval '1 millisecond')
         returning id`,
        [
          input.namespaceId,
          input.runId,
          input.queueName,
          input.taskType,
          JSON.stringify(input.payload ?? {}),
          instant(),
          delayMs,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("task insert returned no row");
      }
      return row.id;
    },

    async dequeue(dequeueOptions: DequeueOptions): Promise<LeasedTask[]> {
      const limit = dequeueOptions.limit ?? 1;
      assertPositiveInteger("visibilityTimeoutMs", dequeueOptions.visibilityTimeoutMs);
      assertPositiveInteger("limit", limit);
      const result = await pool.query<TaskRow>(
        `with next as (
           select id, state = 'LEASED' as reclaimed,
                  state = 'LEASED' and reclaim_count + 1 >= $8 as poisoned
           from tasks
           where queue_name = $1 and state in ('PENDING', 'LEASED') and visible_at <= ${at("$2")}
             and ($7::text is null or task_type <> 'WORKFLOW_TASK' or not exists (
               select 1 from run_stickiness sticky
               where sticky.run_id = tasks.run_id
                 and sticky.worker_id <> $7
                 and sticky.expires_at > ${at("$2")}
             ))
           order by visible_at, created_at, id
           limit $4
           for update skip locked
         ),
         parked as (
           update tasks
           set state = 'QUARANTINED', lease_token = null, leased_by = null,
               leased_by_version = null, leased_at = null,
               reclaim_count = tasks.reclaim_count + 1, quarantined_at = ${at("$2")},
               quarantine_reason = 'lease lost ' || (tasks.reclaim_count + 1)::text || ' times',
               updated_at = ${at("$2")}
           from next
           where tasks.id = next.id and next.poisoned
           returning tasks.id
         )
         update tasks
         set state = 'LEASED',
             lease_token = gen_random_uuid(),
             attempts = tasks.attempts + 1,
             reclaim_count = tasks.reclaim_count + case when next.reclaimed then 1 else 0 end,
             leased_by = $5,
             leased_by_version = $6,
             leased_at = ${at("$2")},
             visible_at = ${at("$2")} + $3 * interval '1 millisecond',
             updated_at = ${at("$2")}
         from next
         where tasks.id = next.id and not next.poisoned
         returning tasks.id, namespace_id, run_id, queue_name, task_type, payload,
                   attempts, lease_token, visible_at`,
        [
          dequeueOptions.queueName,
          instant(),
          dequeueOptions.visibilityTimeoutMs,
          limit,
          dequeueOptions.workerId ?? null,
          dequeueOptions.workerVersion ?? null,
          dequeueOptions.stickyFor ?? null,
          poisonThreshold,
        ],
      );
      return result.rows.map(toLeasedTask);
    },

    async ack(taskId: string, leaseToken: string): Promise<boolean> {
      const result = await pool.query(
        `update tasks set state = 'COMPLETED', lease_token = null, leased_by = null,
             leased_by_version = null, updated_at = ${at("$3")}
         where id = $1 and lease_token = $2 and state = 'LEASED'`,
        [taskId, leaseToken, instant()],
      );
      return result.rowCount === 1;
    },

    async nack(taskId: string, leaseToken: string, delayMs = 0): Promise<boolean> {
      assertNonNegativeInteger("delayMs", delayMs);
      const result = await pool.query(
        `update tasks
         set state = 'PENDING', lease_token = null, leased_by = null, leased_by_version = null,
             visible_at = ${at("$3")} + $4 * interval '1 millisecond', updated_at = ${at("$3")}
         where id = $1 and lease_token = $2 and state = 'LEASED'`,
        [taskId, leaseToken, instant(), delayMs],
      );
      return result.rowCount === 1;
    },

    async quarantine(taskId: string, leaseToken: string, reason: string): Promise<boolean> {
      const result = await pool.query(
        `update tasks
         set state = 'QUARANTINED', lease_token = null, leased_by = null,
             leased_by_version = null, leased_at = null, quarantined_at = ${at("$3")},
             quarantine_reason = $4, updated_at = ${at("$3")}
         where id = $1 and lease_token = $2 and state = 'LEASED'`,
        [taskId, leaseToken, instant(), reason],
      );
      return result.rowCount === 1;
    },

    async extend(
      taskId: string,
      leaseToken: string,
      visibilityTimeoutMs: number,
    ): Promise<boolean> {
      assertPositiveInteger("visibilityTimeoutMs", visibilityTimeoutMs);
      const result = await pool.query(
        `update tasks
         set visible_at = ${at("$3")} + $4 * interval '1 millisecond', updated_at = ${at("$3")}
         where id = $1 and lease_token = $2 and state = 'LEASED' and visible_at > ${at("$3")}`,
        [taskId, leaseToken, instant(), visibilityTimeoutMs],
      );
      return result.rowCount === 1;
    },
  };
}
