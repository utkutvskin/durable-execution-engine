import type { Pool } from "pg";
import type { SerializedError } from "../workflow/error-serialization.js";
import { systemClock, type ClockSource } from "../workflow/sources.js";

/**
 * Why a step task was dead-lettered: it used every attempt its policy allows.
 */
export type DeadLetterReason = "MAX_ATTEMPTS_EXHAUSTED";

/**
 * A step task that ran out of attempts and was set aside for an operator.
 * `attempts` is how many attempts the step had used up when it landed here.
 * `requeuedAt` is null while the entry is still waiting.
 */
export interface DeadLetter {
  readonly id: string;
  readonly namespaceId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly queueName: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly error: SerializedError;
  readonly reason: DeadLetterReason;
  readonly createdAt: Date;
  readonly requeuedAt: Date | null;
}

/**
 * What `DeadLetterQueue.add` needs.
 */
export interface AddDeadLetterInput {
  readonly namespaceId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly queueName: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly error: SerializedError;
  readonly reason: DeadLetterReason;
}

/**
 * Filters for `DeadLetterQueue.list`. Requeued entries are left out unless
 * `includeRequeued` is true.
 */
export interface ListDeadLettersOptions {
  readonly runId?: string;
  readonly includeRequeued?: boolean;
}

/**
 * Holds the step tasks that exhausted their attempts and puts them back on
 * their queue on request.
 */
export interface DeadLetterQueue {
  /**
   * Stores a dead letter and returns its id. A step that already has an
   * entry waiting is not stored twice; the existing id is returned.
   */
  add(input: AddDeadLetterInput): Promise<string>;

  list(options?: ListDeadLettersOptions): Promise<DeadLetter[]>;

  get(id: string): Promise<DeadLetter | undefined>;

  /**
   * Enqueues the dead letter's step task again on its original queue with a
   * fresh retry budget, and marks the entry requeued, in one transaction.
   * Returns the new task id, or `undefined` when the entry does not exist
   * or was already requeued.
   */
  requeue(id: string): Promise<string | undefined>;
}

interface DeadLetterRow {
  id: string;
  namespace_id: string;
  run_id: string;
  step_id: string;
  queue_name: string;
  payload: unknown;
  attempts: number;
  error: SerializedError;
  reason: DeadLetterReason;
  created_at: Date;
  requeued_at: Date | null;
}

function toDeadLetter(row: DeadLetterRow): DeadLetter {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    runId: row.run_id,
    stepId: row.step_id,
    queueName: row.queue_name,
    payload: row.payload,
    attempts: row.attempts,
    error: row.error,
    reason: row.reason,
    createdAt: row.created_at,
    requeuedAt: row.requeued_at,
  };
}

function withAttemptOffset(payload: unknown, attemptOffset: number): unknown {
  const base = typeof payload === "object" && payload !== null ? payload : {};
  return { ...base, attemptOffset };
}

/**
 * Creates a `DeadLetterQueue` over `pool`. `clock` supplies the requeue
 * time and the visibility of the requeued task.
 */
export function createDeadLetterQueue(
  pool: Pool,
  options: { readonly clock?: ClockSource } = {},
): DeadLetterQueue {
  const clock = options.clock ?? systemClock;

  return {
    async add(input: AddDeadLetterInput): Promise<string> {
      const inserted = await pool.query<{ id: string }>(
        `insert into dead_letters
           (namespace_id, run_id, step_id, queue_name, payload, attempts, error, reason)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
         on conflict (run_id, step_id) where requeued_at is null do nothing
         returning id`,
        [
          input.namespaceId,
          input.runId,
          input.stepId,
          input.queueName,
          JSON.stringify(input.payload ?? {}),
          input.attempts,
          JSON.stringify(input.error),
          input.reason,
        ],
      );
      const created = inserted.rows[0];
      if (created !== undefined) {
        return created.id;
      }
      const existing = await pool.query<{ id: string }>(
        "select id from dead_letters where run_id = $1 and step_id = $2 and requeued_at is null",
        [input.runId, input.stepId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error(`dead letter for step "${input.stepId}" vanished during insert`);
      }
      return row.id;
    },

    async list(listOptions: ListDeadLettersOptions = {}): Promise<DeadLetter[]> {
      const result = await pool.query<DeadLetterRow>(
        `select * from dead_letters
         where ($1::uuid is null or run_id = $1)
           and ($2::boolean or requeued_at is null)
         order by created_at, id`,
        [listOptions.runId ?? null, listOptions.includeRequeued ?? false],
      );
      return result.rows.map(toDeadLetter);
    },

    async get(id: string): Promise<DeadLetter | undefined> {
      const result = await pool.query<DeadLetterRow>("select * from dead_letters where id = $1", [
        id,
      ]);
      const row = result.rows[0];
      return row === undefined ? undefined : toDeadLetter(row);
    },

    async requeue(id: string): Promise<string | undefined> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const locked = await client.query<DeadLetterRow>(
          "select * from dead_letters where id = $1 and requeued_at is null for update",
          [id],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          await client.query("rollback");
          return undefined;
        }
        const now = clock.now();
        const task = await client.query<{ id: string }>(
          `insert into tasks (namespace_id, run_id, queue_name, task_type, payload, visible_at)
           values ($1, $2, $3, 'STEP_TASK', $4::jsonb, $5)
           returning id`,
          [
            row.namespace_id,
            row.run_id,
            row.queue_name,
            JSON.stringify(withAttemptOffset(row.payload, row.attempts)),
            now,
          ],
        );
        await client.query("update dead_letters set requeued_at = $2 where id = $1", [id, now]);
        await client.query("commit");
        return task.rows[0]?.id;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
