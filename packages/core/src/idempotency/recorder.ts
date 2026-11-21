import type { Pool, PoolClient } from "pg";
import { withClient } from "../db/transaction.ts";
import { enqueueStepTaskOnClient } from "../queue/step-task-enqueue.ts";
import { systemClock, type ClockSource } from "../workflow/sources.ts";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import { decodeStoredEvent, toConcurrencyError } from "../event-store/event-store.ts";
import { CURRENT_EVENT_VERSION } from "../event-store/event-version.ts";
import { applyRunProjectionOnClient } from "../cancellation/close-run.ts";
import { lockEventAddressOnClient, registerEventWaitOnClient } from "../events/external-events.ts";
import { createContinuedRunOnClient } from "../continuation/continued-run.ts";
import { applySearchAttributeUpsertOnClient } from "../visibility/search-attribute-store.ts";
import { createChildRunOnClient } from "../children/child-runs.ts";
import { foldUnfoldedProjection } from "../run/projection-store.ts";
import type { RunProjection } from "../run/projection.ts";
import { insertTimerOnClient } from "../timers/timer-scheduler.ts";
import { noopTracing, type TraceSpan, type Tracing } from "../observability/tracing.ts";
import {
  workflowEventSchema,
  type RecordedError,
  type WorkflowEvent,
} from "../event-store/events.ts";
import type { SerializedError } from "../workflow/error-serialization.ts";

/**
 * The outcome of one step attempt: the value the step returned, or the
 * error it threw.
 */
export type StepOutcome =
  | { readonly status: "completed"; readonly result: unknown }
  | {
      readonly status: "failed";
      readonly error: SerializedError;
      readonly exhausted?: boolean;
    };

/**
 * What `recordStepResult` needs. `attemptKey` names the logical attempt
 * (not the delivery): every redelivery of the same attempt must pass the
 * same key, so they all resolve to one recorded result.
 */
export interface RecordStepResultInput {
  readonly runId: string;
  readonly stepId: string;
  readonly attemptKey: string;
  readonly outcome: StepOutcome;
}

/**
 * The result of `recordStepResult`. `recorded` is true for the delivery that
 * wrote the result and false for a redelivery, which gets the stored
 * `outcome` back instead of writing again.
 */
export interface RecordedStepResult {
  readonly recorded: boolean;
  readonly outcome: StepOutcome;
}

/**
 * What `recordWorkflowTaskResult` needs. `taskKey` identifies the workflow
 * task across redeliveries; `expectedSeq` is the last sequence number the
 * decision was computed from.
 */
export interface RecordWorkflowTaskResultInput {
  readonly runId: string;
  readonly taskKey: string;
  readonly expectedSeq: number;
  readonly events: readonly WorkflowEvent[];
}

/**
 * The result of `recordWorkflowTaskResult`. `recorded` is false when this
 * task key had already been recorded; `firstSequenceNumber` and
 * `lastSequenceNumber` then describe the events the first delivery wrote
 * (`lastSequenceNumber` is `firstSequenceNumber - 1` for an empty decision).
 */
export interface RecordedWorkflowTaskResult {
  readonly recorded: boolean;
  readonly firstSequenceNumber: number;
  readonly lastSequenceNumber: number;
}

/**
 * The step task `completeStepTask` settles: its id, run and current lease.
 */
export interface SettledStepTask {
  readonly id: string;
  readonly runId: string;
  readonly leaseToken: string;
}

/**
 * What `completeStepTask` does besides the ack. `result` is recorded as
 * `recordStepResult` records it (left out, nothing is recorded). With
 * `followUpQueue`, a `WORKFLOW_TASK` with `followUpPayload` is enqueued on
 * that queue for the run, unless the run is closed. `now` is the time the
 * task rows are stamped with; without it the database's time is used.
 */
export interface CompleteStepTaskInput {
  readonly result?: Omit<RecordStepResultInput, "runId">;
  readonly followUpQueue?: string;
  readonly followUpPayload?: unknown;
  readonly now?: Date;
}

/**
 * The result of `completeStepTask`: what `recordStepResult` would have
 * returned (`recorded` is false and `outcome` undefined when nothing was to
 * be recorded) and whether the lease was still current, so the ack applied.
 */
export interface CompletedStepTask {
  readonly recorded: boolean;
  readonly outcome: StepOutcome | undefined;
  readonly acked: boolean;
}

/**
 * Records step results and workflow task decisions exactly once, however
 * many times the same task is delivered.
 */
export interface ResultRecorder {
  /**
   * Writes the step's result row and the matching `step_completed` or
   * `step_failed` event in one transaction. A repeat of the same
   * `(runId, stepId, attemptKey)` writes nothing and returns the first
   * delivery's stored outcome. A result for a run that is already closed is
   * discarded: nothing is written and `recorded` is false. A failure anywhere
   * in the transaction leaves neither the row nor the event behind. With
   * `client`, the write joins the caller's open transaction instead of
   * starting its own, and the caller commits or rolls back.
   */
  recordStepResult(input: RecordStepResultInput, client?: PoolClient): Promise<RecordedStepResult>;

  /**
   * Settles a step task in one statement: records `input.result` with the
   * rules of `recordStepResult`, enqueues the run's follow-up workflow task
   * and acks `task`, in that order and atomically. A recorded result whose
   * ack finds the lease gone stays recorded, as it would with three separate
   * calls.
   */
  completeStepTask(task: SettledStepTask, input: CompleteStepTaskInput): Promise<CompletedStepTask>;

  /**
   * Appends a workflow task's decision events and marks the task key as
   * recorded in one transaction. A repeat of the same `(runId, taskKey)`
   * appends nothing. A `timer_started` event also creates its durable
   * timer row in the same transaction, so a timer exists exactly when its
   * event does. A new key whose `expectedSeq` is stale is rejected
   * with a `ConcurrencyError` and records nothing. A decision for a run that
   * is already closed is discarded: nothing is appended and `recorded` is
   * false, so no step can be scheduled after a cancellation or termination.
   * An event that closes the run also brings its projection up to date,
   * withdraws the run's waiting tasks and settles its parent and children
   * (see `closeRunIfTerminal`), in the same transaction. A `child_started`
   * event also creates the child run, its `run_started` event and its first
   * workflow task, once per `childId`. A `run_continued_as_new` event closes
   * the run as `CONTINUED_AS_NEW` and creates the next run of its chain with
   * its first workflow task, in the same transaction.
   */
  recordWorkflowTaskResult(
    input: RecordWorkflowTaskResultInput,
  ): Promise<RecordedWorkflowTaskResult>;
}

interface StepResultRow {
  result: unknown;
  error: SerializedError | null;
}

const CLOSING_EVENT_TYPES: ReadonlySet<WorkflowEvent["type"]> = new Set([
  "run_completed",
  "run_failed",
  "run_timed_out",
  "run_cancelled",
  "run_terminated",
  "run_continued_as_new",
]);

async function readNamespaceId(client: PoolClient, runId: string): Promise<string> {
  const result = await client.query<{ namespace_id: string }>(
    "select namespace_id from workflow_runs where id = $1",
    [runId],
  );
  return result.rows[0]?.namespace_id ?? "";
}

function recordedErrorOf(error: SerializedError): RecordedError {
  return {
    name: error.name,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.cause === undefined ? {} : { cause: recordedErrorOf(error.cause) }),
  };
}

function toStepEvent(input: RecordStepResultInput): WorkflowEvent {
  if (input.outcome.status === "completed") {
    return workflowEventSchema.parse({
      type: "step_completed",
      stepId: input.stepId,
      result: input.outcome.result,
    });
  }
  return workflowEventSchema.parse({
    type: "step_failed",
    stepId: input.stepId,
    error: recordedErrorOf(input.outcome.error),
    ...(input.outcome.exhausted === true ? { exhausted: true } : {}),
  });
}

function toOutcome(row: StepResultRow): StepOutcome {
  if (row.error !== null) {
    return { status: "failed", error: row.error };
  }
  return { status: "completed", result: row.result };
}

interface StepResultFunctionRow {
  recorded: boolean;
  run_closed: boolean;
  stored_result: unknown;
  stored_error: SerializedError | null;
  acked: boolean;
}

const RECORD_STEP_RESULT_SQL = `select recorded, run_closed, stored_result, stored_error, acked
   from record_step_result(
     $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::uuid, $10::uuid, $11, $12::jsonb, $13
   )`;

function stepResultValues(
  codec: Codec,
  runId: string,
  result: Omit<RecordStepResultInput, "runId"> | undefined,
  settle: {
    readonly taskId: string | null;
    readonly leaseToken: string | null;
    readonly followUpQueue: string | null;
    readonly followUpPayload: unknown;
    readonly now: Date | null;
  },
): unknown[] {
  const event = result === undefined ? undefined : toStepEvent({ ...result, runId });
  const outcome = result?.outcome;
  return [
    runId,
    result?.stepId ?? null,
    result?.attemptKey ?? null,
    outcome?.status === "completed" ? JSON.stringify(outcome.result ?? null) : null,
    outcome?.status === "failed" ? JSON.stringify(outcome.error) : null,
    event?.type ?? null,
    event === undefined ? null : codec.encode(event),
    CURRENT_EVENT_VERSION,
    settle.taskId,
    settle.leaseToken,
    settle.followUpQueue,
    settle.followUpQueue === null ? null : JSON.stringify(settle.followUpPayload ?? {}),
    settle.now,
  ];
}

function storedOutcome(row: StepResultFunctionRow, given: StepOutcome): StepOutcome {
  if (row.recorded || row.run_closed) {
    return given;
  }
  return toOutcome({ result: row.stored_result, error: row.stored_error });
}

const SIDE_EFFECT_EVENT_TYPES: ReadonlySet<WorkflowEvent["type"]> = new Set([
  "child_started",
  "search_attributes_upserted",
  "run_continued_as_new",
  "timer_started",
  "event_wait_started",
]);

interface WorkflowTaskRow {
  outcome: "recorded" | "duplicate" | "closed";
  first_sequence_number: string;
  last_sequence_number: string;
  traceparent: string | null;
  namespace_id: string | null;
  run_status: string | null;
  run_input: unknown;
  run_result: unknown;
  run_error: { name: string; message: string } | null;
  run_closed_at: Date | null;
  projected_sequence_number: string | null;
  unfolded_sequence_numbers: string[] | null;
  unfolded_payloads: string[] | null;
  unfolded_versions: number[] | null;
  unfolded_created_at: Date[] | null;
}

const RECORD_WORKFLOW_TASK_SQL = `select outcome, first_sequence_number, last_sequence_number, traceparent,
          namespace_id, run_status, run_input, run_result, run_error, run_closed_at,
          projected_sequence_number, unfolded_sequence_numbers, unfolded_payloads,
          unfolded_versions, unfolded_created_at
   from record_workflow_task($1, $2, $3, $4::text[], $5::text[], $6, $7)`;

function unfoldedProjectionOf(codec: Codec, row: WorkflowTaskRow): RunProjection {
  const sequences = row.unfolded_sequence_numbers ?? [];
  const payloads = row.unfolded_payloads ?? [];
  const versions = row.unfolded_versions ?? [];
  const createdAt = row.unfolded_created_at ?? [];
  return foldUnfoldedProjection({
    status: row.run_status ?? "RUNNING",
    input: row.run_input,
    result: row.run_result,
    error: row.run_error,
    closedAt: row.run_closed_at,
    lastSequenceNumber: Number(row.projected_sequence_number ?? "0"),
    events: sequences.map((sequence, index) =>
      decodeStoredEvent(
        codec,
        Number(sequence),
        payloads[index] ?? "null",
        createdAt[index] ?? new Date(0),
        versions[index] ?? CURRENT_EVENT_VERSION,
      ),
    ),
  });
}

/**
 * Options for `createResultRecorder`. `queueName` is the queue the first
 * workflow task of each child run goes to; recording a `child_started` event
 * without it is an error. With `tracing`, every recorded workflow task emits
 * a `workflow.task` span and every created child run a `workflow.child`
 * span, both under the run's stored `traceparent`. Redelivered, discarded or
 * rolled back tasks emit nothing.
 */
export interface ResultRecorderOptions {
  readonly queueName?: string;
  readonly tracing?: Tracing;
  readonly clock?: ClockSource;
}

/**
 * Creates a `ResultRecorder` over `pool`. Events are encoded with `codec`,
 * the same codec the `EventStore` reading them uses.
 *
 * Concurrent deliveries of one attempt serialize on the table's unique
 * constraint: the loser waits for the winner's transaction, sees the
 * conflict, and reads the winner's row. Writes to one run are serialized by
 * a row lock on `workflow_runs`, so two different steps finishing at once
 * both append cleanly.
 */
export function createResultRecorder(
  pool: Pool,
  codec: Codec = jsonCodec,
  recorderOptions: ResultRecorderOptions = {},
): ResultRecorder {
  const tracing = recorderOptions.tracing ?? noopTracing;
  const clock = recorderOptions.clock ?? systemClock;
  return {
    async recordStepResult(
      input: RecordStepResultInput,
      joined?: PoolClient,
    ): Promise<RecordedStepResult> {
      const values = stepResultValues(codec, input.runId, input, {
        taskId: null,
        leaseToken: null,
        followUpQueue: null,
        followUpPayload: undefined,
        now: null,
      });
      const result = await (joined ?? pool).query<StepResultFunctionRow>(
        RECORD_STEP_RESULT_SQL,
        values,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`recording step "${input.stepId}" of run "${input.runId}" returned no row`);
      }
      return { recorded: row.recorded, outcome: storedOutcome(row, input.outcome) };
    },

    async completeStepTask(
      task: SettledStepTask,
      input: CompleteStepTaskInput,
    ): Promise<CompletedStepTask> {
      const values = stepResultValues(codec, task.runId, input.result, {
        taskId: task.id,
        leaseToken: task.leaseToken,
        followUpQueue: input.followUpQueue ?? null,
        followUpPayload: input.followUpPayload,
        now: input.now ?? null,
      });
      const result = await pool.query<StepResultFunctionRow>(RECORD_STEP_RESULT_SQL, values);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`settling step task "${task.id}" returned no row`);
      }
      return {
        recorded: row.recorded,
        outcome: input.result === undefined ? undefined : storedOutcome(row, input.result.outcome),
        acked: row.acked,
      };
    },

    async recordWorkflowTaskResult(
      input: RecordWorkflowTaskResultInput,
    ): Promise<RecordedWorkflowTaskResult> {
      const events = input.events.map((event) => workflowEventSchema.parse(event));
      const waits = events.filter(
        (event): event is Extract<WorkflowEvent, { type: "event_wait_started" }> =>
          event.type === "event_wait_started",
      );
      const closing = events.some((event) => CLOSING_EVENT_TYPES.has(event.type));
      const needsTransaction =
        closing ||
        events.some(
          (event) =>
            SIDE_EFFECT_EVENT_TYPES.has(event.type) ||
            (event.type === "step_scheduled" && recorderOptions.queueName !== undefined),
        );
      const values = [
        input.runId,
        input.taskKey,
        input.expectedSeq,
        events.map((event) => event.type),
        events.map((event) => codec.encode(event)),
        CURRENT_EVENT_VERSION,
        closing,
      ];
      const recordOn = async (client: Pool | PoolClient): Promise<WorkflowTaskRow> => {
        try {
          const result = await client.query<WorkflowTaskRow>(RECORD_WORKFLOW_TASK_SQL, values);
          const row = result.rows[0];
          if (row === undefined) {
            throw new Error(`recording workflow task of run "${input.runId}" returned no row`);
          }
          return row;
        } catch (error) {
          throw toConcurrencyError(error, input.runId, input.expectedSeq);
        }
      };
      const finish = (
        row: WorkflowTaskRow,
        pendingSpans: readonly TraceSpan[],
      ): RecordedWorkflowTaskResult => {
        const firstSequenceNumber = Number(row.first_sequence_number);
        const lastSequenceNumber = Number(row.last_sequence_number);
        if (row.outcome !== "recorded") {
          return { recorded: false, firstSequenceNumber, lastSequenceNumber };
        }
        const taskSpan = tracing.startSpan("workflow.task", {
          parent: row.traceparent,
          attributes: {
            "dee.run.id": input.runId,
            "dee.task.key": input.taskKey,
            "dee.events.count": events.length,
          },
        });
        taskSpan.end();
        for (const span of pendingSpans) {
          span.end();
        }
        return { recorded: true, firstSequenceNumber, lastSequenceNumber };
      };
      if (!needsTransaction) {
        return finish(await recordOn(pool), []);
      }
      return withClient(pool, async (client) => {
        const pendingSpans: TraceSpan[] = [];
        await client.query("begin");
        if (waits.length > 0) {
          const namespaceId = await readNamespaceId(client, input.runId);
          const addresses = [
            ...new Set(waits.map((wait) => JSON.stringify([wait.eventName, wait.key]))),
          ]
            .sort()
            .map((address) => JSON.parse(address) as [string, string]);
          for (const [eventName, key] of addresses) {
            await lockEventAddressOnClient(client, namespaceId, eventName, key);
          }
        }
        const row = await recordOn(client);
        if (row.outcome !== "recorded") {
          await client.query("commit");
          return finish(row, []);
        }
        const traceparent = row.traceparent;
        const namespaceId = row.namespace_id ?? "";
        for (const event of events) {
          if (event.type === "child_started") {
            if (recorderOptions.queueName === undefined) {
              throw new Error("recording a child workflow needs a queueName");
            }
            const childSpan = tracing.startSpan("workflow.child", {
              parent: traceparent,
              attributes: {
                "dee.run.id": input.runId,
                "dee.child.id": event.childId,
                "dee.workflow.type": event.workflowType,
              },
            });
            const child = await createChildRunOnClient(
              client,
              codec,
              {
                runId: input.runId,
                namespaceId,
                queueName: recorderOptions.queueName,
                traceparent: childSpan.traceparent ?? traceparent,
                now: clock.now(),
              },
              event,
            );
            if (child.created) {
              pendingSpans.push(childSpan);
            }
          }
          if (event.type === "search_attributes_upserted") {
            await applySearchAttributeUpsertOnClient(client, input.runId, event.searchAttributes);
          }
          if (event.type === "run_continued_as_new") {
            await createContinuedRunOnClient(client, codec, input.runId, event, clock.now());
          }
          if (event.type === "step_scheduled" && recorderOptions.queueName !== undefined) {
            await enqueueStepTaskOnClient(client, {
              namespaceId,
              runId: input.runId,
              queueName: recorderOptions.queueName,
              stepId: event.stepId,
              stepType: event.stepType,
              input: event.input,
              now: clock.now(),
            });
          }
          if (event.type === "timer_started") {
            await insertTimerOnClient(client, {
              runId: input.runId,
              timerId: event.timerId,
              fireAt: new Date(event.fireAt),
            });
          }
        }
        if (closing) {
          await applyRunProjectionOnClient(
            client,
            codec,
            input.runId,
            unfoldedProjectionOf(codec, row),
          );
        }
        for (const wait of waits) {
          await registerEventWaitOnClient(client, codec, input.runId, wait, clock.now());
        }
        await client.query("commit");
        return finish(row, pendingSpans);
      });
    },
  };
}
