import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/transaction.ts";
import type { ClockSource } from "../workflow/sources.ts";

/**
 * Limits how many runs of a workflow, or how many executions of a step, run
 * at once for one business key. `key` is evaluated from the input of the run
 * or the step, for example `(order) => order.customerId`; `limit` runs or
 * steps with the same key hold a slot at a time. Runs and steps draw from
 * separate pools, so a workflow key and a step key with the same text never
 * share slots. Within a pool, every waiting run or step is held to its own
 * `limit`.
 */
export interface ConcurrencyRule<TInput = never> {
  readonly key: (input: TInput) => string;
  readonly limit: number;
}

/**
 * A concurrency rule evaluated for one input: the key it gave and the limit
 * that goes with it.
 */
export interface ResolvedConcurrency {
  readonly key: string;
  readonly limit: number;
}

/**
 * The longest key, in characters, that a concurrency rule may return.
 */
export const MAX_CONCURRENCY_KEY_LENGTH = 256;

/**
 * Thrown when a concurrency rule has a limit that is not a positive integer,
 * or its key function returns something other than a non-empty string of at
 * most `MAX_CONCURRENCY_KEY_LENGTH` characters.
 */
export class InvalidConcurrencyRuleError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConcurrencyRuleError";
  }
}

/**
 * Checks a rule at definition time: `limit` must be a positive integer and
 * `key` a function. `owner` names the definition in the error message.
 */
export function validateConcurrencyRule<TInput>(
  owner: string,
  rule: ConcurrencyRule<TInput>,
): ConcurrencyRule<TInput> {
  if (typeof rule.key !== "function") {
    throw new InvalidConcurrencyRuleError(`${owner} has a concurrency key that is not a function`);
  }
  if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
    throw new InvalidConcurrencyRuleError(
      `${owner} has a concurrency limit that is not a positive integer (${String(rule.limit)})`,
    );
  }
  return rule;
}

/**
 * Evaluates `rule` for `input`. Rejects with `InvalidConcurrencyRuleError`
 * when the key is not a non-empty string of at most
 * `MAX_CONCURRENCY_KEY_LENGTH` characters; an error thrown by the key
 * function itself is passed on unchanged.
 */
export function resolveConcurrency<TInput>(
  owner: string,
  rule: ConcurrencyRule<TInput>,
  input: TInput,
): ResolvedConcurrency {
  const key: unknown = rule.key(input);
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_CONCURRENCY_KEY_LENGTH) {
    throw new InvalidConcurrencyRuleError(
      `${owner} gave a concurrency key that is not a string of 1 to ${String(MAX_CONCURRENCY_KEY_LENGTH)} characters (got ${typeof key === "string" ? `${String(key.length)} characters` : typeof key})`,
    );
  }
  return { key, limit: rule.limit };
}

/**
 * What `requeueWithConcurrency` records: the leased task, and the run key,
 * the step key or both. `run` is written on the run and on every open task
 * of the run, `step` on the task alone.
 */
export interface ConcurrencyAssignment {
  readonly taskId: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly run?: ResolvedConcurrency;
  readonly step?: ResolvedConcurrency;
}

/**
 * Records the evaluated keys of a task whose definition has a concurrency
 * rule, and hands the task back to the queue in the same transaction, so the
 * next dequeue leases it only once it holds a slot. Nothing ran under the
 * lease that is given back. Resolves `false`, writing nothing, when the
 * lease is no longer current.
 */
export async function requeueWithConcurrency(
  pool: Pool,
  assignment: ConcurrencyAssignment,
  options: { readonly clock?: ClockSource } = {},
): Promise<boolean> {
  const now = options.clock?.now() ?? null;
  return withTransaction(pool, async (client) => {
    const released = await client.query(
      `update tasks
       set state = 'PENDING', lease_token = null, leased_by = null, leased_by_version = null,
           visible_at = coalesce($3::timestamptz, now()), updated_at = coalesce($3::timestamptz, now()),
           step_concurrency_key = coalesce($4, step_concurrency_key),
           step_concurrency_limit = coalesce($5, step_concurrency_limit)
       where id = $1 and lease_token = $2 and state = 'LEASED'`,
      [
        assignment.taskId,
        assignment.leaseToken,
        now,
        assignment.step?.key ?? null,
        assignment.step?.limit ?? null,
      ],
    );
    if (released.rowCount !== 1) {
      return false;
    }
    if (assignment.run !== undefined) {
      await assignRunConcurrency(client, assignment.runId, assignment.run);
    }
    return true;
  });
}

async function assignRunConcurrency(
  client: PoolClient,
  runId: string,
  run: ResolvedConcurrency,
): Promise<void> {
  await client.query(
    `update workflow_runs set concurrency_key = $2, concurrency_limit = $3 where id = $1`,
    [runId, run.key, run.limit],
  );
  await client.query(
    `update tasks set concurrency_key = $2, concurrency_limit = $3
     where run_id = $1 and state in ('PENDING', 'LEASED')`,
    [runId, run.key, run.limit],
  );
}

/**
 * Whether a run is subject to a workflow concurrency key, and if so whether
 * it holds a slot now (`holdsSlot`) and whether it has work that waits for
 * one (`waitingForSlot`): an open task that is due but cannot be leased
 * because `limit` other runs hold the key's slots. `holders` counts the
 * runs holding a slot of the key.
 */
export interface RunConcurrencyState {
  readonly key: string;
  readonly limit: number;
  readonly holders: number;
  readonly holdsSlot: boolean;
  readonly waitingForSlot: boolean;
}

/**
 * Reads the `RunConcurrencyState` of a run, or `undefined` when the run has
 * no workflow concurrency key (or does not exist).
 */
export async function readRunConcurrency(
  pool: Pool,
  runId: string,
): Promise<RunConcurrencyState | undefined> {
  const result = await pool.query<{
    concurrency_key: string;
    concurrency_limit: number;
    holders: string;
    holds_slot: boolean;
    has_due_task: boolean;
  }>(
    `select run.concurrency_key, run.concurrency_limit,
            (select count(distinct held.run_id) from concurrency_slots held
             where held.namespace_id = run.namespace_id and held.scope = 'run'
               and held.concurrency_key = run.concurrency_key) as holders,
            exists (
              select 1 from concurrency_slots held
              where held.scope = 'run' and held.run_id = run.id
            ) as holds_slot,
            exists (
              select 1 from tasks
              where tasks.run_id = run.id and tasks.state = 'PENDING' and tasks.visible_at <= now()
            ) as has_due_task
     from workflow_runs run
     where run.id = $1 and run.concurrency_key is not null`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const holders = Number(row.holders);
  return {
    key: row.concurrency_key,
    limit: row.concurrency_limit,
    holders,
    holdsSlot: row.holds_slot,
    waitingForSlot: !row.holds_slot && row.has_due_task && holders >= row.concurrency_limit,
  };
}

/**
 * One concurrency key as `readConcurrencyBacklog` reports it: the pool
 * (`run` or `step`), the namespace, the key, how many slots are held and how
 * many due tasks wait for a slot.
 */
export interface ConcurrencyBacklogEntry {
  readonly scope: "run" | "step";
  readonly namespace: string;
  readonly key: string;
  readonly held: number;
  readonly queued: number;
}

/**
 * Reports every concurrency key that holds a slot or has queued work, the
 * keys with the most queued tasks first, at most `limit` keys (default 100).
 * A task counts as queued when it is due and not leased; a task of a run that
 * already holds its run slot does not count for the run pool.
 */
export async function readConcurrencyBacklog(
  pool: Pool,
  options: { readonly limit?: number; readonly clock?: ClockSource } = {},
): Promise<ConcurrencyBacklogEntry[]> {
  const result = await pool.query<{
    scope: "run" | "step";
    namespace: string;
    concurrency_key: string;
    held: string;
    queued: string;
  }>(
    `with waiting as (
       select 'run' as scope, tasks.namespace_id, tasks.concurrency_key, count(*) as queued
       from tasks
       where tasks.concurrency_key is not null and tasks.state = 'PENDING'
         and tasks.visible_at <= coalesce($2::timestamptz, now())
         and not exists (
           select 1 from concurrency_slots held
           where held.scope = 'run' and held.run_id = tasks.run_id
         )
       group by tasks.namespace_id, tasks.concurrency_key
       union all
       select 'step', namespace_id, step_concurrency_key, count(*)
       from tasks
       where step_concurrency_key is not null and state = 'PENDING'
         and visible_at <= coalesce($2::timestamptz, now())
       group by namespace_id, step_concurrency_key
     ),
     holding as (
       select scope, namespace_id, concurrency_key, count(*) as held
       from concurrency_slots
       where expires_at is null or expires_at > coalesce($2::timestamptz, now())
       group by scope, namespace_id, concurrency_key
     )
     select coalesce(waiting.scope, holding.scope) as scope, namespaces.name as namespace,
            coalesce(waiting.concurrency_key, holding.concurrency_key) as concurrency_key,
            coalesce(holding.held, 0) as held, coalesce(waiting.queued, 0) as queued
     from waiting
     full join holding on holding.scope = waiting.scope
       and holding.namespace_id = waiting.namespace_id
       and holding.concurrency_key = waiting.concurrency_key
     join namespaces on namespaces.id = coalesce(waiting.namespace_id, holding.namespace_id)
     order by queued desc, held desc, namespace, concurrency_key, scope
     limit $1`,
    [options.limit ?? 100, options.clock?.now() ?? null],
  );
  return result.rows.map((row) => ({
    scope: row.scope,
    namespace: row.namespace,
    key: row.concurrency_key,
    held: Number(row.held),
    queued: Number(row.queued),
  }));
}
