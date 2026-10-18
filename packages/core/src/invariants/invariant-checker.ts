import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { readSnapshotOnClient } from "../compaction/snapshot.js";
import type { EventStore } from "../event-store/event-store.js";
import { createInitialProjection, foldRunEvents, type RunProjection } from "../run/projection.js";
import { isTerminalState } from "../run/state-machine.js";

/**
 * The names of the invariants `createInvariantChecker` evaluates.
 */
export const INVARIANT_NAMES = [
  "run-terminal-or-advancing",
  "task-not-lost",
  "step-result-written-once",
  "projection-consistent",
  "timer-fired-once",
] as const;

/**
 * One of the values of `INVARIANT_NAMES`.
 */
export type InvariantName = (typeof INVARIANT_NAMES)[number];

/**
 * One broken invariant. `runId` and `taskId` name the offending rows when
 * there are any; `detail` says what is wrong in a sentence.
 */
export interface InvariantViolation {
  readonly invariant: InvariantName;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly detail: string;
}

/**
 * The outcome of one `InvariantChecker.check`: how many runs and tasks were
 * examined and every violation found. An empty `violations` list means every
 * invariant held for the examined rows.
 */
export interface InvariantReport {
  readonly runsChecked: number;
  readonly tasksChecked: number;
  readonly violations: readonly InvariantViolation[];
}

/**
 * Narrows `InvariantChecker.check`. `runIds` limits it to those runs (default
 * every run in the database). `expectedTaskIds` are tasks the caller enqueued
 * and knows must still exist, which is how a task that vanished without a
 * trace is caught.
 */
export interface InvariantCheckOptions {
  readonly runIds?: readonly string[];
  readonly expectedTaskIds?: readonly string[];
}

/**
 * Evaluates the engine's safety invariants against the database.
 *
 * - `run-terminal-or-advancing`: a `RUNNING` run has an open task, a pending
 *   timer, an open dead letter or a running child. A run with none of these
 *   can never move again. A run that waits for a signal looks the same, so the
 *   checker is meant for workloads that do not park runs on signals.
 * - `task-not-lost`: a `LEASED` task carries a lease token, every expected
 *   task still exists, and a `COMPLETED` step task left its step an outcome,
 *   a failed attempt or a dead letter.
 * - `step-result-written-once`: a step has at most one terminal event and one
 *   `step_results` row, and every row has its event.
 * - `projection-consistent`: the run row equals the fold of the event log up
 *   to the row's own sequence number, never runs ahead of the log, and is
 *   terminal whenever the log is.
 * - `timer-fired-once`: a timer has at most one `timer_fired` event, a fired
 *   timer has its event and no timer fired before it was due.
 */
export interface InvariantChecker {
  check(options?: InvariantCheckOptions): Promise<InvariantReport>;
}

interface RunRow {
  id: string;
  status: string;
  input: unknown;
  result: unknown;
  error: { name: string; message: string } | null;
  closed_at: Date | null;
  last_sequence_number: string;
}

function violation(
  invariant: InvariantName,
  detail: string,
  runId: string | null = null,
  taskId: string | null = null,
): InvariantViolation {
  return { invariant, runId, taskId, detail };
}

function describeProjectionDifference(
  row: RunRow,
  expected: RunProjection,
  rowSequence: number,
): string | undefined {
  if (row.status !== expected.state) {
    return `row status ${row.status} but the log up to ${String(rowSequence)} gives ${expected.state}`;
  }
  if (!isDeepStrictEqual(row.result, expected.result)) {
    return `row result differs from the log up to ${String(rowSequence)}`;
  }
  if (!isDeepStrictEqual(row.error, expected.error)) {
    return `row error differs from the log up to ${String(rowSequence)}`;
  }
  if (rowSequence > 0 && !isDeepStrictEqual(row.input, expected.input)) {
    return `row input differs from the log up to ${String(rowSequence)}`;
  }
  if ((row.closed_at === null) !== (expected.closedAt === null)) {
    return `row closed_at is ${row.closed_at === null ? "empty" : "set"} but the log says ${expected.closedAt === null ? "open" : "closed"}`;
  }
  return undefined;
}

/**
 * Creates an `InvariantChecker` over `pool` that reads run histories through
 * `store`. Checking only reads: it takes no locks and changes no row, so it
 * can run against a live system, but a run that is mid-write may then show a
 * transient violation. Run it once the workload has settled.
 */
export function createInvariantChecker(pool: Pool, store: EventStore): InvariantChecker {
  function scope(options: InvariantCheckOptions): string[] | null {
    return options.runIds === undefined ? null : [...options.runIds];
  }

  async function stalledRuns(runIds: string[] | null): Promise<InvariantViolation[]> {
    const result = await pool.query<{ id: string }>(
      `select r.id from workflow_runs r
       where r.status = 'RUNNING' and ($1::uuid[] is null or r.id = any($1::uuid[]))
         and not exists (
           select 1 from tasks t
           where t.run_id = r.id and t.state in ('PENDING', 'LEASED', 'QUARANTINED'))
         and not exists (select 1 from timers m where m.run_id = r.id and m.state = 'PENDING')
         and not exists (
           select 1 from dead_letters d where d.run_id = r.id and d.requeued_at is null)
         and not exists (
           select 1 from workflow_runs c where c.parent_run_id = r.id and c.status = 'RUNNING')
       order by r.id`,
      [runIds],
    );
    return result.rows.map((row) =>
      violation(
        "run-terminal-or-advancing",
        "run is RUNNING but has no open task, pending timer, open dead letter or running child",
        row.id,
      ),
    );
  }

  async function lostTasks(
    runIds: string[] | null,
    expectedTaskIds: readonly string[],
  ): Promise<{ violations: InvariantViolation[]; tasksChecked: number }> {
    const violations: InvariantViolation[] = [];
    const unleased = await pool.query<{ id: string; run_id: string }>(
      `select id, run_id from tasks
       where state = 'LEASED' and lease_token is null
         and ($1::uuid[] is null or run_id = any($1::uuid[]))`,
      [runIds],
    );
    for (const row of unleased.rows) {
      violations.push(
        violation("task-not-lost", "task is LEASED without a lease token", row.run_id, row.id),
      );
    }
    const unrecorded = await pool.query<{ id: string; run_id: string; step_id: string }>(
      `select t.id, t.run_id, t.payload->>'stepId' as step_id
       from tasks t join workflow_runs r on r.id = t.run_id
       where t.task_type = 'STEP_TASK' and t.state = 'COMPLETED' and t.payload ? 'stepId'
         and r.status in ('RUNNING', 'COMPLETED')
         and ($1::uuid[] is null or t.run_id = any($1::uuid[]))
         and not exists (select 1 from run_snapshots s where s.run_id = t.run_id)
         and not exists (
           select 1 from run_events e
           where e.run_id = t.run_id and e.payload->>'stepId' = t.payload->>'stepId'
             and e.event_type in ('step_completed', 'step_failed', 'step_attempt_failed'))
         and not exists (
           select 1 from dead_letters d
           where d.run_id = t.run_id and d.step_id = t.payload->>'stepId')`,
      [runIds],
    );
    for (const row of unrecorded.rows) {
      violations.push(
        violation(
          "task-not-lost",
          `step task for "${row.step_id}" was acked but the step has no outcome, failed attempt or dead letter`,
          row.run_id,
          row.id,
        ),
      );
    }
    let tasksChecked = 0;
    if (expectedTaskIds.length > 0) {
      const present = await pool.query<{ id: string }>(
        "select id from tasks where id = any($1::uuid[])",
        [[...expectedTaskIds]],
      );
      const found = new Set(present.rows.map((row) => row.id));
      tasksChecked = found.size;
      for (const taskId of expectedTaskIds) {
        if (!found.has(taskId)) {
          violations.push(violation("task-not-lost", "task no longer exists", null, taskId));
        }
      }
    }
    return { violations, tasksChecked };
  }

  async function duplicateSteps(runIds: string[] | null): Promise<InvariantViolation[]> {
    const violations: InvariantViolation[] = [];
    const events = await pool.query<{ run_id: string; step_id: string; copies: string }>(
      `select run_id, payload->>'stepId' as step_id, count(*) as copies
       from run_events
       where event_type in ('step_completed', 'step_failed')
         and ($1::uuid[] is null or run_id = any($1::uuid[]))
       group by run_id, payload->>'stepId' having count(*) > 1`,
      [runIds],
    );
    for (const row of events.rows) {
      violations.push(
        violation(
          "step-result-written-once",
          `step "${row.step_id}" has ${row.copies} terminal events`,
          row.run_id,
        ),
      );
    }
    const results = await pool.query<{ run_id: string; step_id: string; copies: string }>(
      `select run_id, step_id, count(*) as copies from step_results
       where $1::uuid[] is null or run_id = any($1::uuid[])
       group by run_id, step_id having count(*) > 1`,
      [runIds],
    );
    for (const row of results.rows) {
      violations.push(
        violation(
          "step-result-written-once",
          `step "${row.step_id}" has ${row.copies} stored results`,
          row.run_id,
        ),
      );
    }
    const orphaned = await pool.query<{ run_id: string; step_id: string }>(
      `select distinct s.run_id, s.step_id from step_results s
       where ($1::uuid[] is null or s.run_id = any($1::uuid[]))
         and not exists (select 1 from run_snapshots p where p.run_id = s.run_id)
         and not exists (
           select 1 from run_events e
           where e.run_id = s.run_id and e.payload->>'stepId' = s.step_id
             and e.event_type in ('step_completed', 'step_failed'))`,
      [runIds],
    );
    for (const row of orphaned.rows) {
      violations.push(
        violation(
          "step-result-written-once",
          `step "${row.step_id}" has a stored result but no terminal event`,
          row.run_id,
        ),
      );
    }
    return violations;
  }

  async function timerViolations(runIds: string[] | null): Promise<InvariantViolation[]> {
    const violations: InvariantViolation[] = [];
    const duplicated = await pool.query<{ run_id: string; timer_id: string; copies: string }>(
      `select run_id, payload->>'timerId' as timer_id, count(*) as copies
       from run_events
       where event_type = 'timer_fired' and ($1::uuid[] is null or run_id = any($1::uuid[]))
       group by run_id, payload->>'timerId' having count(*) > 1`,
      [runIds],
    );
    for (const row of duplicated.rows) {
      violations.push(
        violation(
          "timer-fired-once",
          `timer "${row.timer_id}" has ${row.copies} timer_fired events`,
          row.run_id,
        ),
      );
    }
    const unannounced = await pool.query<{ run_id: string; timer_id: string }>(
      `select t.run_id, t.timer_id from timers t
       where t.state = 'FIRED' and ($1::uuid[] is null or t.run_id = any($1::uuid[]))
         and not exists (select 1 from run_snapshots p where p.run_id = t.run_id)
         and not exists (
           select 1 from run_events e
           where e.run_id = t.run_id and e.event_type = 'timer_fired'
             and e.payload->>'timerId' = t.timer_id)`,
      [runIds],
    );
    for (const row of unannounced.rows) {
      violations.push(
        violation(
          "timer-fired-once",
          `timer "${row.timer_id}" is marked fired but has no timer_fired event`,
          row.run_id,
        ),
      );
    }
    const early = await pool.query<{ run_id: string; timer_id: string }>(
      `select run_id, timer_id from timers
       where state = 'FIRED' and fired_at < fire_at
         and ($1::uuid[] is null or run_id = any($1::uuid[]))`,
      [runIds],
    );
    for (const row of early.rows) {
      violations.push(
        violation(
          "timer-fired-once",
          `timer "${row.timer_id}" fired before it was due`,
          row.run_id,
        ),
      );
    }
    return violations;
  }

  async function inconsistentProjections(
    runIds: string[] | null,
  ): Promise<{ violations: InvariantViolation[]; runsChecked: number }> {
    const runs = await pool.query<RunRow>(
      `select id, status, input, result, error, closed_at, last_sequence_number
       from workflow_runs where $1::uuid[] is null or id = any($1::uuid[]) order by id`,
      [runIds],
    );
    const violations: InvariantViolation[] = [];
    const client = await pool.connect();
    try {
      for (const row of runs.rows) {
        const snapshot = await readSnapshotOnClient(client, row.id);
        const base = snapshot?.projection ?? createInitialProjection();
        const rowSequence = Number(row.last_sequence_number);
        const events = await store.read(row.id, base.lastSequenceNumber);
        const logEnd = events.at(-1)?.sequenceNumber ?? base.lastSequenceNumber;
        if (rowSequence > logEnd) {
          violations.push(
            violation(
              "projection-consistent",
              `row is at sequence ${String(rowSequence)} but the log ends at ${String(logEnd)}`,
              row.id,
            ),
          );
          continue;
        }
        if (rowSequence < base.lastSequenceNumber) {
          violations.push(
            violation(
              "projection-consistent",
              `row is at sequence ${String(rowSequence)}, before its snapshot at ${String(base.lastSequenceNumber)}`,
              row.id,
            ),
          );
          continue;
        }
        try {
          const upToRow = foldRunEvents(
            events.filter((stored) => stored.sequenceNumber <= rowSequence),
            base,
          );
          const difference = describeProjectionDifference(row, upToRow, rowSequence);
          if (difference !== undefined) {
            violations.push(violation("projection-consistent", difference, row.id));
          }
          const full = foldRunEvents(events, base);
          if (isTerminalState(full.state) && !isTerminalState(upToRow.state)) {
            violations.push(
              violation(
                "projection-consistent",
                `the log closed the run as ${full.state} but the row is still ${upToRow.state}`,
                row.id,
              ),
            );
          }
        } catch (error) {
          violations.push(
            violation(
              "projection-consistent",
              `the log is not a valid history: ${error instanceof Error ? error.message : String(error)}`,
              row.id,
            ),
          );
        }
      }
    } finally {
      client.release();
    }
    return { violations, runsChecked: runs.rows.length };
  }

  return {
    async check(options: InvariantCheckOptions = {}): Promise<InvariantReport> {
      const runIds = scope(options);
      const stalled = await stalledRuns(runIds);
      const tasks = await lostTasks(runIds, options.expectedTaskIds ?? []);
      const steps = await duplicateSteps(runIds);
      const timers = await timerViolations(runIds);
      const projections = await inconsistentProjections(runIds);
      return {
        runsChecked: projections.runsChecked,
        tasksChecked: tasks.tasksChecked,
        violations: [
          ...stalled,
          ...tasks.violations,
          ...steps,
          ...projections.violations,
          ...timers,
        ],
      };
    },
  };
}
