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
  readonly priority: number;
  readonly concurrencyKey: string | null;
  readonly stepConcurrencyKey: string | null;
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
 * `taskTypes` limits the call to tasks of those types (default both), which
 * is how a worker keeps separate pools for decisions and steps.
 *
 * Tasks are taken in priority order, highest first (a task has its run's
 * priority). Tasks of equal priority are spread across namespaces: each
 * namespace's oldest task comes before any namespace's second, and among
 * namespaces the one served least recently goes first, so a namespace with a
 * deep backlog cannot hold back a namespace with a few tasks.
 *
 * Tasks held back by a pause (see `createPauseControl`) are skipped: a
 * paused namespace or queue lane is not scanned at all, and a paused run's
 * tasks are passed over. They are leased once the pause is resumed.
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
  readonly taskTypes?: readonly TaskType[];
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
  priority: number;
  concurrency_key: string | null;
  step_concurrency_key: string | null;
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
    priority: row.priority,
    concurrencyKey: row.concurrency_key,
    stepConcurrencyKey: row.step_concurrency_key,
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

function resolveTaskTypes(taskTypes: readonly TaskType[] | undefined): TaskType[] {
  if (taskTypes === undefined) {
    return [...TASK_TYPES];
  }
  const unknown = taskTypes.filter((type) => !TASK_TYPES.includes(type));
  if (taskTypes.length === 0 || unknown.length > 0) {
    throw new RangeError(
      `taskTypes must name at least one of ${TASK_TYPES.join(", ")}, got [${taskTypes.join(", ")}]`,
    );
  }
  return [...new Set(taskTypes)];
}

const DATABASE_NOW = "now()";
const DEQUEUE_PARAMETERS = 9;

interface HeldBack {
  readonly laneFilter: string;
  readonly runFilter: string;
  readonly values: readonly string[][];
}

/**
 * Reads the pauses that concern a dequeue of `queueName` and turns them into
 * filters of the dequeue statement, numbered after its own parameters.
 * Without a pause both filters are empty and the statement is the one of an
 * engine without pauses: any extra predicate raises its estimated cost over
 * Postgres' default `jit_above_cost`, and JIT compilation then adds about
 * 100 ms to every poll.
 */
async function readHeldBack(pool: Pool, queueName: string): Promise<HeldBack> {
  const pauses = await pool.query<{ scope: string; namespace_id: string; run_id: string | null }>(
    `select scope, namespace_id, run_id from pauses
     where scope in ('namespace', 'run') or (scope = 'queue' and queue_name = $1)`,
    [queueName],
  );
  const namespaces = pauses.rows
    .filter((row) => row.scope !== "run")
    .map((row) => row.namespace_id);
  const runs = pauses.rows.flatMap((row) => (row.run_id === null ? [] : [row.run_id]));
  const values: string[][] = [];
  const placeholder = (ids: string[]): string => {
    values.push(ids);
    return `$${String(DEQUEUE_PARAMETERS + values.length)}::uuid[]`;
  };
  return {
    laneFilter: namespaces.length === 0 ? "" : `where n.id <> all (${placeholder(namespaces)})`,
    runFilter: runs.length === 0 ? "" : `and tasks.run_id <> all (${placeholder(runs)})`,
    values,
  };
}

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
      const taskTypes = resolveTaskTypes(dequeueOptions.taskTypes);
      const held = await readHeldBack(pool, dequeueOptions.queueName);
      const result = await pool.query<TaskRow>(
        `with lanes as (
           select n.id as namespace_id, kind.task_type,
                  coalesce((
                    select max(served.lease_seq) from tasks served
                    where served.queue_name = $1 and served.namespace_id = n.id
                      and served.task_type = kind.task_type and served.lease_seq is not null
                  ), 0) as turn
           from namespaces n cross join unnest($9::text[]) as kind (task_type)
           ${held.laneFilter}
         ),
         candidates as (
           select lane_task.*, lanes.turn,
                  row_number() over (
                    partition by lane_task.namespace_id, lane_task.priority
                    order by lane_task.visible_at, lane_task.created_at, lane_task.id
                  ) as lane_rank
           from lanes cross join lateral (
             select id, namespace_id, run_id, priority, visible_at, created_at,
                    concurrency_key, concurrency_limit, step_concurrency_key,
                    step_concurrency_limit,
                    state = 'LEASED' as reclaimed,
                    state = 'LEASED' and reclaim_count + 1 >= $8 as poisoned,
                    concurrency_key is not null and exists (
                      select 1 from concurrency_slots held
                      where held.scope = 'run' and held.run_id = tasks.run_id
                    ) as run_holds
             from tasks
             where queue_name = $1 and namespace_id = lanes.namespace_id
               and task_type = lanes.task_type
               and state in ('PENDING', 'LEASED') and visible_at <= ${at("$2")}
               ${held.runFilter}
               and ($7::text is null or task_type <> 'WORKFLOW_TASK' or not exists (
                 select 1 from run_stickiness sticky
                 where sticky.run_id = tasks.run_id
                   and sticky.worker_id <> $7
                   and sticky.expires_at > ${at("$2")}
               ))
               and (concurrency_key is null or exists (
                 select 1 from concurrency_slots held
                 where held.scope = 'run' and held.run_id = tasks.run_id
               ) or (
                 select count(*) from concurrency_slots held
                 where held.namespace_id = tasks.namespace_id and held.scope = 'run'
                   and held.concurrency_key = tasks.concurrency_key
               ) < concurrency_limit)
               and (step_concurrency_key is null or (
                 select count(*) from concurrency_slots held
                 where held.namespace_id = tasks.namespace_id and held.scope = 'step'
                   and held.concurrency_key = tasks.step_concurrency_key
                   and held.expires_at > ${at("$2")}
               ) < step_concurrency_limit)
             order by priority desc, visible_at, created_at, id
             limit $4
             for update skip locked
           ) lane_task
         ),
         next as (
           select id, namespace_id, run_id, reclaimed, poisoned, run_holds, concurrency_key,
                  concurrency_limit, step_concurrency_key, step_concurrency_limit,
                  gen_random_uuid() as lease_token,
                  row_number() over (
                    order by priority desc, lane_rank, turn, visible_at, created_at, id
                  ) as position
           from candidates
           order by position
           limit $4
         ),
         run_requests as (
           select distinct on (namespace_id, run_id)
                  namespace_id, run_id, concurrency_key, concurrency_limit, position
           from next
           where not poisoned and concurrency_key is not null and not run_holds
           order by namespace_id, run_id, position
         ),
         requests as (
           select 'run' as scope, namespace_id, concurrency_key, concurrency_limit as slot_limit,
                  run_id, null::uuid as task_id, null::uuid as lease_token,
                  null::timestamptz as expires_at,
                  row_number() over (
                    partition by namespace_id, concurrency_key order by position
                  ) as wanted
           from run_requests
           union all
           select 'step', namespace_id, step_concurrency_key, step_concurrency_limit,
                  run_id, id, lease_token,
                  ${at("$2")} + $3 * interval '1 millisecond',
                  row_number() over (
                    partition by namespace_id, step_concurrency_key order by position
                  )
           from next
           where not poisoned and step_concurrency_key is not null
         ),
         free_slots as (
           select pools.scope, pools.namespace_id, pools.concurrency_key, free.slot,
                  row_number() over (
                    partition by pools.scope, pools.namespace_id, pools.concurrency_key
                    order by free.slot
                  ) as free_rank
           from (
             select scope, namespace_id, concurrency_key, max(slot_limit) as slot_limit
             from requests group by scope, namespace_id, concurrency_key
           ) pools
           cross join lateral generate_series(0, pools.slot_limit - 1) as free (slot)
           where not exists (
             select 1 from concurrency_slots held
             where held.namespace_id = pools.namespace_id and held.scope = pools.scope
               and held.concurrency_key = pools.concurrency_key and held.slot = free.slot
               and (held.expires_at is null or held.expires_at > ${at("$2")})
           )
         ),
         acquired as (
           insert into concurrency_slots
             (namespace_id, scope, concurrency_key, slot, slot_limit, run_id, task_id,
              lease_token, expires_at, acquired_at)
           select requests.namespace_id, requests.scope, requests.concurrency_key,
                  free_slots.slot, requests.slot_limit, requests.run_id, requests.task_id,
                  requests.lease_token, requests.expires_at, ${at("$2")}
           from requests
           join free_slots on free_slots.scope = requests.scope
             and free_slots.namespace_id = requests.namespace_id
             and free_slots.concurrency_key = requests.concurrency_key
             and free_slots.free_rank = requests.wanted
           where free_slots.slot < requests.slot_limit
           on conflict (namespace_id, scope, concurrency_key, slot) do update
           set slot_limit = excluded.slot_limit, run_id = excluded.run_id,
               task_id = excluded.task_id, lease_token = excluded.lease_token,
               expires_at = excluded.expires_at, acquired_at = excluded.acquired_at
           where concurrency_slots.expires_at <= ${at("$2")}
           returning scope, run_id, task_id
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
         ),
         leased as (
           update tasks
           set state = 'LEASED',
               lease_token = next.lease_token,
               lease_seq = nextval('task_lease_seq'),
               attempts = tasks.attempts + 1,
               reclaim_count = tasks.reclaim_count + case when next.reclaimed then 1 else 0 end,
               leased_by = $5,
               leased_by_version = $6,
               leased_at = ${at("$2")},
               visible_at = ${at("$2")} + $3 * interval '1 millisecond',
               updated_at = ${at("$2")}
           from next
           where tasks.id = next.id and not next.poisoned
             and (next.concurrency_key is null or next.run_holds or next.run_id in (
               select run_id from acquired where scope = 'run'
             ))
             and (next.step_concurrency_key is null or next.id in (
               select task_id from acquired where scope = 'step'
             ))
           returning tasks.id, tasks.namespace_id, tasks.run_id, queue_name, task_type, payload,
                     attempts, tasks.lease_token, visible_at, priority, tasks.concurrency_key,
                     tasks.step_concurrency_key, next.position
         )
         select id, namespace_id, run_id, queue_name, task_type, payload,
                attempts, lease_token, visible_at, priority, concurrency_key,
                step_concurrency_key
         from leased order by position`,
        [
          dequeueOptions.queueName,
          instant(),
          dequeueOptions.visibilityTimeoutMs,
          limit,
          dequeueOptions.workerId ?? null,
          dequeueOptions.workerVersion ?? null,
          dequeueOptions.stickyFor ?? null,
          poisonThreshold,
          taskTypes,
          ...held.values,
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
