import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { lockRunWithParent } from "../children/run-locks.ts";
import { closeRunIfTerminal } from "../cancellation/close-run.ts";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import {
  appendEventsOnClient,
  readEventsOnClient,
  type StoredEvent,
} from "../event-store/event-store.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { withTransaction } from "../db/transaction.ts";
import { enqueueStepTaskOnClient } from "../queue/step-task-enqueue.ts";
import { insertRunOnClient } from "../run/insert-run.ts";
import { RunNotFoundError } from "../signals/signal-service.ts";
import { systemClock, type ClockSource } from "../workflow/sources.ts";
import { mergeSearchAttributes, type SearchAttributes } from "../visibility/search-attributes.ts";

/**
 * Where a reset or fork cuts a run's history. The new run keeps every event
 * up to and including the cut and continues from there.
 *
 * - `event`: keep the events up to sequence number `sequence`.
 * - `step`: keep everything before the `step`th step the run scheduled
 *   (1-based, in the order of its `step_scheduled` events), so that step and
 *   every later one runs again.
 * - `failed-step`: keep everything before the first step that failed for
 *   good (`step_failed`), so the failed step runs again.
 */
export type ResetPoint =
  | { readonly kind: "event"; readonly sequence: number }
  | { readonly kind: "step"; readonly step: number }
  | { readonly kind: "failed-step" };

/**
 * What a new run copied from an old one is: `reset` replaces the old run,
 * which is terminated if it is still open, and `fork` leaves it untouched.
 */
export type ResetKind = "reset" | "fork";

/**
 * Raised when a reset or fork cannot cut the run's history where it was
 * asked to, with the reason in the message. A cut must keep the first
 * event, must not keep a closing event or a cancellation request, and must
 * not leave a timer, a child workflow, an event wait without a timeout or an
 * update unfinished. Steps that were scheduled but have no result are
 * allowed: the new run executes them.
 */
export class InvalidResetPointError extends Error {
  readonly runId: string;

  constructor(runId: string, reason: string) {
    super(`workflow run "${runId}" cannot be reset there: ${reason}`);
    this.name = "InvalidResetPointError";
    this.runId = runId;
  }
}

/**
 * What `resetRunOnClient` needs. `workflowType` replaces the workflow type
 * of the new run (a fork onto new code registered under another name);
 * without it the new run keeps the old run's type. `reason` is recorded on
 * the `run_terminated` event of a reset that closes an open run.
 */
export interface ResetRunInput {
  readonly runId: string;
  readonly point: ResetPoint;
  readonly kind?: ResetKind;
  readonly workflowType?: string;
  readonly reason?: string;
}

/**
 * What a reset or fork did. `runId` is the new run, `eventSequence` the
 * last event copied into it, `terminatedOriginal` whether a reset closed the
 * old run because it was still open, and `rescheduledSteps` the steps the
 * new run executes again right away because the cut kept their
 * `step_scheduled` event but not their result.
 */
export interface ResetReceipt {
  readonly runId: string;
  readonly resetFromRunId: string;
  readonly kind: ResetKind;
  readonly workflowType: string;
  readonly eventSequence: number;
  readonly terminatedOriginal: boolean;
  readonly rescheduledSteps: readonly string[];
}

/**
 * A place a run's history can be cut, as `listResetPoints` reports it:
 * the last event kept, its type, and for a step's `step_scheduled` event
 * the step it starts (`step` is its 1-based position).
 */
export interface ResetPointCandidate {
  readonly sequence: number;
  readonly eventType: WorkflowEvent["type"];
  readonly stepId?: string;
  readonly stepType?: string;
  readonly step?: number;
}

interface ResetRunRow {
  namespace_id: string;
  workflow_type: string;
  queue_name: string;
  priority: number;
  memo: unknown;
  run_timeout_ms: string | null;
  status: string;
}

const CLOSING_EVENTS: ReadonlySet<WorkflowEvent["type"]> = new Set([
  "run_completed",
  "run_failed",
  "run_timed_out",
  "run_cancelled",
  "run_terminated",
  "run_continued_as_new",
  "cancel_requested",
]);

class PrefixTracker {
  private closing: WorkflowEvent["type"] | undefined;
  private readonly timers = new Set<string>();
  private readonly children = new Set<string>();
  private readonly waits = new Map<string, boolean>();
  private readonly updates = new Set<string>();

  add(event: WorkflowEvent): void {
    if (CLOSING_EVENTS.has(event.type)) {
      this.closing ??= event.type;
    }
    switch (event.type) {
      case "timer_started":
        this.timers.add(event.timerId);
        break;
      case "timer_fired":
        this.timers.delete(event.timerId);
        break;
      case "child_started":
        this.children.add(event.childId);
        break;
      case "child_completed":
      case "child_failed":
        this.children.delete(event.childId);
        break;
      case "event_wait_started":
        this.waits.set(event.waitId, event.expiresAt === undefined);
        break;
      case "event_received":
        this.waits.delete(event.waitId);
        break;
      case "update_accepted":
        this.updates.add(event.updateId);
        break;
      case "update_completed":
        this.updates.delete(event.updateId);
        break;
      default:
        break;
    }
  }

  problem(): string | undefined {
    if (this.closing !== undefined) {
      return `the history up to there already holds ${this.closing}`;
    }
    const [timer] = this.timers;
    if (timer !== undefined) {
      return `timer "${timer}" has not fired`;
    }
    const [child] = this.children;
    if (child !== undefined) {
      return `child workflow "${child}" has not closed`;
    }
    const wait = [...this.waits].find(([, withoutTimeout]) => withoutTimeout);
    if (wait !== undefined) {
      return `event wait "${wait[0]}" has not received its event`;
    }
    const [update] = this.updates;
    if (update !== undefined) {
      return `update "${update}" has not finished`;
    }
    return undefined;
  }
}

function prefixProblem(events: readonly WorkflowEvent[]): string | undefined {
  const tracker = new PrefixTracker();
  for (const event of events) {
    tracker.add(event);
  }
  return tracker.problem();
}

function stepScheduledSequences(history: readonly StoredEvent[]): number[] {
  return history
    .filter((stored) => stored.event.type === "step_scheduled")
    .map((stored) => stored.sequenceNumber);
}

/**
 * Turns `point` into the sequence number of the last event a cut of
 * `history` keeps. Rejects with `InvalidResetPointError` when the point
 * names no event, no step, or a run without a step that failed for good.
 */
export function resolveResetPoint(
  runId: string,
  history: readonly StoredEvent[],
  point: ResetPoint,
): number {
  const last = history.at(-1)?.sequenceNumber ?? 0;
  if (point.kind === "event") {
    if (!Number.isInteger(point.sequence) || point.sequence < 1 || point.sequence > last) {
      throw new InvalidResetPointError(
        runId,
        `event ${String(point.sequence)} is not between 1 and ${String(last)}`,
      );
    }
    return point.sequence;
  }
  if (point.kind === "step") {
    const scheduled = stepScheduledSequences(history);
    const sequence = Number.isInteger(point.step) ? scheduled[point.step - 1] : undefined;
    if (sequence === undefined || point.step < 1) {
      throw new InvalidResetPointError(
        runId,
        `step ${String(point.step)} is not between 1 and ${String(scheduled.length)}`,
      );
    }
    return sequence - 1;
  }
  const failed = history.find((stored) => stored.event.type === "step_failed");
  const failedStepId = failed?.event.type === "step_failed" ? failed.event.stepId : undefined;
  const scheduled = history.find(
    (stored) => stored.event.type === "step_scheduled" && stored.event.stepId === failedStepId,
  );
  if (scheduled === undefined) {
    throw new InvalidResetPointError(runId, "no step of the run failed for good");
  }
  return scheduled.sequenceNumber - 1;
}

/**
 * Every sequence number `history` can be cut at, oldest first, with the
 * step whose `step_scheduled` event each cut keeps last, if any.
 */
export function resetPointCandidates(history: readonly StoredEvent[]): ResetPointCandidate[] {
  const candidates: ResetPointCandidate[] = [];
  if (history[0]?.event.type !== "run_started") {
    return candidates;
  }
  const tracker = new PrefixTracker();
  let step = 0;
  for (const stored of history) {
    const { event } = stored;
    tracker.add(event);
    if (event.type === "step_scheduled") {
      step += 1;
    }
    if (tracker.problem() !== undefined) {
      continue;
    }
    candidates.push(
      event.type === "step_scheduled"
        ? {
            sequence: stored.sequenceNumber,
            eventType: event.type,
            stepId: event.stepId,
            stepType: event.stepType,
            step,
          }
        : { sequence: stored.sequenceNumber, eventType: event.type },
    );
  }
  return candidates;
}

function foldSearchAttributes(events: readonly WorkflowEvent[]): SearchAttributes {
  let attributes: SearchAttributes = {};
  for (const event of events) {
    if (event.type === "run_started") {
      attributes = event.searchAttributes ?? {};
    }
    if (event.type === "search_attributes_upserted") {
      attributes = mergeSearchAttributes(attributes, event.searchAttributes);
    }
  }
  return attributes;
}

function openSteps(
  events: readonly WorkflowEvent[],
): Extract<WorkflowEvent, { type: "step_scheduled" }>[] {
  const finished = new Set<string>();
  for (const event of events) {
    if (event.type === "step_completed" || event.type === "step_failed") {
      finished.add(event.stepId);
    }
  }
  return events.flatMap((event) =>
    event.type === "step_scheduled" && !finished.has(event.stepId) ? [event] : [],
  );
}

async function readCompleteHistory(
  client: PoolClient,
  codec: Codec,
  runId: string,
): Promise<StoredEvent[]> {
  const history = await readEventsOnClient(client, codec, runId);
  if (history[0]?.sequenceNumber !== 1 || history[0].event.type !== "run_started") {
    throw new InvalidResetPointError(
      runId,
      "its history was compacted or purged, so it no longer starts with run_started",
    );
  }
  return history;
}

/**
 * Reads the places `runId`'s history can be cut at on `client`. Rejects
 * with `RunNotFoundError`, or with `InvalidResetPointError` when the
 * history no longer starts with its first event.
 */
export async function listResetPointsOnClient(
  client: PoolClient,
  codec: Codec,
  runId: string,
): Promise<ResetPointCandidate[]> {
  const exists = await client.query("select 1 from workflow_runs where id = $1", [runId]);
  if (exists.rowCount === 0) {
    throw new RunNotFoundError(runId);
  }
  return resetPointCandidates(await readCompleteHistory(client, codec, runId));
}

/**
 * Resets or forks `input.runId` inside the caller's open transaction on
 * `client`: takes the run's row lock (its parent's first), copies its
 * history up to the cut into a new run in the same namespace and on the
 * same queue, with the same input, memo, priority and run timeout and the
 * search attributes it held at the cut, links the new run to the old one
 * (`reset_from_run_id`, `reset_event_sequence`, `reset_kind`), and enqueues
 * its first workflow task plus a step task for every step the cut kept
 * without a result. The new run starts a chain of its own and has no
 * parent. Events are copied as stored, so encrypted payloads stay
 * encrypted. A reset of an open run then terminates the old run. Rejects
 * with `RunNotFoundError` or `InvalidResetPointError`; nothing is written
 * then.
 */
export async function resetRunOnClient(
  client: PoolClient,
  codec: Codec,
  input: ResetRunInput,
  now: Date = new Date(),
): Promise<ResetReceipt> {
  const kind = input.kind ?? "reset";
  const locked = await lockRunWithParent(client, input.runId);
  if (locked === undefined) {
    throw new RunNotFoundError(input.runId);
  }
  const loaded = await client.query<ResetRunRow>(
    `select namespace_id, workflow_type, queue_name, priority, memo, run_timeout_ms, status
     from workflow_runs where id = $1`,
    [input.runId],
  );
  const row = loaded.rows[0];
  if (row === undefined) {
    throw new RunNotFoundError(input.runId);
  }
  const history = await readCompleteHistory(client, codec, input.runId);
  const sequence = resolveResetPoint(input.runId, history, input.point);
  const kept = history.slice(0, sequence).map((stored) => stored.event);
  const problem = prefixProblem(kept);
  if (problem !== undefined) {
    throw new InvalidResetPointError(input.runId, problem);
  }
  const [started, ...rest] = kept;
  if (started?.type !== "run_started") {
    throw new InvalidResetPointError(input.runId, "the cut does not keep run_started");
  }
  const workflowType = input.workflowType ?? started.workflowType;
  const newRunId = randomUUID();
  await insertRunOnClient(client, codec, {
    namespaceId: row.namespace_id,
    workflowType,
    input: started.input,
    queueName: row.queue_name,
    runId: newRunId,
    taskReason: kind,
    priority: row.priority,
    runTimeoutMs: row.run_timeout_ms === null ? undefined : Number(row.run_timeout_ms),
    ...(started.searchAttributes === undefined
      ? {}
      : { searchAttributes: started.searchAttributes }),
    ...(row.memo === null ? {} : { memo: row.memo }),
  });
  await appendEventsOnClient(client, codec, newRunId, 1, rest);
  await client.query(
    `update workflow_runs
     set search_attributes = $2::jsonb, reset_from_run_id = $3, reset_event_sequence = $4,
         reset_kind = $5
     where id = $1`,
    [newRunId, JSON.stringify(foldSearchAttributes(kept)), input.runId, sequence, kind],
  );
  for (const [index, event] of kept.entries()) {
    if (event.type === "signal_received" && event.signalId !== undefined) {
      await client.query(
        `insert into signal_ids (first_run_id, signal_id, run_id, sequence_number)
         values ($1, $2, $1, $3) on conflict do nothing`,
        [newRunId, event.signalId, index + 1],
      );
    }
  }
  const pending = openSteps(kept);
  for (const step of pending) {
    await enqueueStepTaskOnClient(client, {
      namespaceId: row.namespace_id,
      runId: newRunId,
      queueName: row.queue_name,
      stepId: step.stepId,
      stepType: step.stepType,
      input: step.input,
      now,
    });
  }
  const terminatedOriginal = kind === "reset" && row.status === "RUNNING";
  if (terminatedOriginal) {
    const current = history.at(-1)?.sequenceNumber ?? 0;
    await appendEventsOnClient(client, codec, input.runId, current, [
      { type: "run_terminated", reason: input.reason ?? `reset to run ${newRunId}` },
    ]);
    await closeRunIfTerminal(client, codec, input.runId);
  }
  return {
    runId: newRunId,
    resetFromRunId: input.runId,
    kind,
    workflowType,
    eventSequence: sequence,
    terminatedOriginal,
    rescheduledSteps: pending.map((step) => step.stepId),
  };
}

/**
 * Options for `createRunReset`. `codec` must be the event codec the run
 * histories were written with.
 */
export interface RunResetOptions {
  readonly codec?: Codec;
  readonly clock?: ClockSource;
}

/**
 * Resets and forks runs, each in a transaction of its own. See
 * `resetRunOnClient`.
 */
export interface RunReset {
  /** Replaces `input.runId` with a new run cut at `input.point`. */
  resetRun(input: Omit<ResetRunInput, "kind">): Promise<ResetReceipt>;
  /** Starts a new run cut at `input.point`, leaving `input.runId` as it is. */
  forkRun(input: Omit<ResetRunInput, "kind">): Promise<ResetReceipt>;
  /** Lists the places `runId`'s history can be cut at. */
  listResetPoints(runId: string): Promise<ResetPointCandidate[]>;
}

/**
 * Creates `RunReset` over `pool`.
 */
export function createRunReset(pool: Pool, options: RunResetOptions = {}): RunReset {
  const codec = options.codec ?? jsonCodec;
  const clock = options.clock ?? systemClock;
  return {
    resetRun(input) {
      return withTransaction(pool, (client) =>
        resetRunOnClient(client, codec, { ...input, kind: "reset" }, clock.now()),
      );
    },
    forkRun(input) {
      return withTransaction(pool, (client) =>
        resetRunOnClient(client, codec, { ...input, kind: "fork" }, clock.now()),
      );
    },
    listResetPoints(runId) {
      return withTransaction(pool, (client) => listResetPointsOnClient(client, codec, runId));
    },
  };
}
