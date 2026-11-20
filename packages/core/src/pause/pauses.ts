import type { Pool } from "pg";
import { RunAlreadyClosedError } from "../cancellation/run-control.ts";
import { RunNotFoundError } from "../signals/signal-service.ts";

/**
 * What a pause holds back: every task of a `namespace`, every task of one
 * queue in a namespace, or every task of one `run`.
 */
export type PauseScope = "namespace" | "queue" | "run";

/**
 * The thing to pause or resume. A queue is named as tasks carry it, and is
 * paused for one namespace only.
 */
export type PauseTarget =
  | { readonly scope: "namespace"; readonly namespaceId: string }
  | { readonly scope: "queue"; readonly namespaceId: string; readonly queueName: string }
  | { readonly scope: "run"; readonly namespaceId: string; readonly runId: string };

/**
 * A pause as stored. `queueName` is set for a queue pause and `runId` for a
 * run pause.
 */
export interface PauseRecord {
  readonly id: string;
  readonly scope: PauseScope;
  readonly namespaceId: string;
  readonly queueName: string | null;
  readonly runId: string | null;
  readonly reason: string | null;
  readonly pausedAt: Date;
}

/**
 * What `PauseControl.pause` reports: the pause in force and whether this
 * call created it. Pausing what is already paused keeps the first pause.
 */
export interface PauseReceipt {
  readonly pause: PauseRecord;
  readonly created: boolean;
}

/**
 * Pauses and resumes work. A pause only stops the dequeue: tasks of paused
 * work stay `PENDING` and keep their order, timers still fire and enqueue
 * their workflow task, signals and events are still recorded, and a task
 * already leased runs to its end. Resuming deletes the pause, and the next
 * poll leases the held tasks.
 */
export interface PauseControl {
  /**
   * Pauses `target`. A run pause rejects with `RunNotFoundError` for a run
   * outside the namespace and `RunAlreadyClosedError` for a closed run.
   */
  pause(target: PauseTarget, reason?: string): Promise<PauseReceipt>;

  /** Removes the pause of `target`. Resolves `false` when it was not paused. */
  resume(target: PauseTarget): Promise<boolean>;

  /** Lists the namespace's pauses, oldest first. */
  list(namespaceId: string): Promise<PauseRecord[]>;

  /**
   * The pauses that hold back `runId`: its own, its queue's and its
   * namespace's, run first. Empty when the run is not held.
   */
  pausesOfRun(namespaceId: string, runId: string): Promise<PauseRecord[]>;
}

interface PauseRow {
  id: string;
  scope: PauseScope;
  namespace_id: string;
  queue_name: string | null;
  run_id: string | null;
  reason: string | null;
  paused_at: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_ORDER = "case scope when 'run' then 0 when 'queue' then 1 else 2 end";

function toRecord(row: PauseRow): PauseRecord {
  return {
    id: row.id,
    scope: row.scope,
    namespaceId: row.namespace_id,
    queueName: row.queue_name,
    runId: row.run_id,
    reason: row.reason,
    pausedAt: row.paused_at,
  };
}

function queueOf(target: PauseTarget): string | null {
  return target.scope === "queue" ? target.queueName : null;
}

function runOf(target: PauseTarget): string | null {
  return target.scope === "run" ? target.runId : null;
}

const TARGET_CONDITION = `scope = $1 and namespace_id = $2
  and queue_name is not distinct from $3 and run_id is not distinct from $4::uuid`;

async function assertOpenRun(db: Pool, namespaceId: string, runId: string): Promise<void> {
  if (!UUID_PATTERN.test(runId)) {
    throw new RunNotFoundError(runId);
  }
  const found = await db.query<{ status: string }>(
    "select status from workflow_runs where id = $1 and namespace_id = $2",
    [runId, namespaceId],
  );
  const status = found.rows[0]?.status;
  if (status === undefined) {
    throw new RunNotFoundError(runId);
  }
  if (status !== "RUNNING") {
    throw new RunAlreadyClosedError(runId, status);
  }
}

/**
 * Creates a `PauseControl` over `pool`.
 */
export function createPauseControl(pool: Pool): PauseControl {
  return {
    async pause(target: PauseTarget, reason?: string): Promise<PauseReceipt> {
      if (target.scope === "run") {
        await assertOpenRun(pool, target.namespaceId, target.runId);
      }
      if (target.scope === "queue" && target.queueName.length === 0) {
        throw new RangeError("a queue pause needs a queue name");
      }
      const values = [target.scope, target.namespaceId, queueOf(target), runOf(target)];
      const inserted = await pool.query<PauseRow>(
        `insert into pauses (scope, namespace_id, queue_name, run_id, reason)
         values ($1, $2, $3, $4::uuid, $5)
         on conflict do nothing
         returning *`,
        [...values, reason ?? null],
      );
      const created = inserted.rows[0];
      if (created !== undefined) {
        return { pause: toRecord(created), created: true };
      }
      const existing = await pool.query<PauseRow>(
        `select * from pauses where ${TARGET_CONDITION}`,
        values,
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error(`the pause of ${target.scope} was neither created nor found`);
      }
      return { pause: toRecord(row), created: false };
    },

    async resume(target: PauseTarget): Promise<boolean> {
      if (target.scope === "run" && !UUID_PATTERN.test(target.runId)) {
        return false;
      }
      const deleted = await pool.query(`delete from pauses where ${TARGET_CONDITION}`, [
        target.scope,
        target.namespaceId,
        queueOf(target),
        runOf(target),
      ]);
      return deleted.rowCount === 1;
    },

    async list(namespaceId: string): Promise<PauseRecord[]> {
      const found = await pool.query<PauseRow>(
        "select * from pauses where namespace_id = $1 order by paused_at, id",
        [namespaceId],
      );
      return found.rows.map(toRecord);
    },

    async pausesOfRun(namespaceId: string, runId: string): Promise<PauseRecord[]> {
      if (!UUID_PATTERN.test(runId)) {
        return [];
      }
      const found = await pool.query<PauseRow>(
        `select p.* from pauses p
         join workflow_runs r on r.namespace_id = p.namespace_id
         where r.id = $2 and r.namespace_id = $1 and (
           p.scope = 'namespace'
           or (p.scope = 'queue' and p.queue_name = r.queue_name)
           or (p.scope = 'run' and p.run_id = r.id)
         )
         order by ${SCOPE_ORDER}, p.paused_at`,
        [namespaceId, runId],
      );
      return found.rows.map(toRecord);
    },
  };
}
