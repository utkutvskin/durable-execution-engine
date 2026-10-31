import type { Pool, PoolClient } from "pg";
import { withClient, withTransaction } from "../db/transaction.js";
import { enqueueStepTaskOnClient } from "../queue/step-task-enqueue.js";
import { systemClock, type ClockSource } from "../workflow/sources.js";
import { jsonCodec, type Codec } from "../event-store/codec.js";
import {
  appendEventsOnClient,
  readCurrentSequenceOnClient,
  type StoredEvent,
} from "../event-store/event-store.js";
import { closeRunIfTerminal } from "../cancellation/close-run.js";
import { createContinuedRunOnClient } from "../continuation/continued-run.js";
import { createChildRunOnClient } from "../children/child-runs.js";
import { lockRunWithParent } from "../children/run-locks.js";
import { isTerminalState, type RunState } from "../run/state-machine.js";
import { insertTimerOnClient } from "../timers/timer-scheduler.js";
import { noopTracing, type TraceSpan, type Tracing } from "../observability/tracing.js";
import { workflowEventSchema, type WorkflowEvent } from "../event-store/events.js";
import type { SerializedError } from "../workflow/error-serialization.js";

/**
 * The outcome of one step attempt: the value the step returned, or the
 * error it threw.
 */
export type StepOutcome =
  | { readonly status: "completed"; readonly result: unknown }
  | { readonly status: "failed"; readonly error: SerializedError };

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
   * in the transaction leaves neither the row nor the event behind.
   */
  recordStepResult(input: RecordStepResultInput): Promise<RecordedStepResult>;

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

async function lockRunStatus(client: PoolClient, runId: string): Promise<RunState | undefined> {
  const locked = await lockRunWithParent(client, runId);
  return locked?.status as RunState | undefined;
}

async function lockRunStatusOnly(client: PoolClient, runId: string): Promise<RunState | undefined> {
  const result = await client.query<{ status: RunState }>(
    "select status from workflow_runs where id = $1 for update",
    [runId],
  );
  return result.rows[0]?.status;
}

async function readNamespaceId(client: PoolClient, runId: string): Promise<string> {
  const result = await client.query<{ namespace_id: string }>(
    "select namespace_id from workflow_runs where id = $1",
    [runId],
  );
  return result.rows[0]?.namespace_id ?? "";
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
    error: { name: input.outcome.error.name, message: input.outcome.error.message },
  });
}

function toOutcome(row: StepResultRow): StepOutcome {
  if (row.error !== null) {
    return { status: "failed", error: row.error };
  }
  return { status: "completed", result: row.result };
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
    async recordStepResult(input: RecordStepResultInput): Promise<RecordedStepResult> {
      const event = toStepEvent(input);
      return withTransaction(pool, async (client) => {
        const status = await lockRunStatusOnly(client, input.runId);
        if (status !== undefined && isTerminalState(status)) {
          return { recorded: false, outcome: input.outcome };
        }
        const existing = await client.query<StepResultRow>(
          "select result, error from step_results where run_id = $1 and step_id = $2",
          [input.runId, input.stepId],
        );
        const first = existing.rows[0];
        if (first !== undefined) {
          return { recorded: false, outcome: toOutcome(first) };
        }
        await client.query(
          `insert into step_results (run_id, step_id, attempt_key, result, error)
           values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            input.runId,
            input.stepId,
            input.attemptKey,
            input.outcome.status === "completed"
              ? JSON.stringify(input.outcome.result ?? null)
              : null,
            input.outcome.status === "failed" ? JSON.stringify(input.outcome.error) : null,
          ],
        );
        const currentSeq = await readCurrentSequenceOnClient(client, input.runId);
        await appendEventsOnClient(client, codec, input.runId, currentSeq, [event]);
        return { recorded: true, outcome: input.outcome };
      });
    },

    async recordWorkflowTaskResult(
      input: RecordWorkflowTaskResultInput,
    ): Promise<RecordedWorkflowTaskResult> {
      const events = input.events.map((event) => workflowEventSchema.parse(event));
      return withClient(pool, async (client) => {
        const pendingSpans: TraceSpan[] = [];
        await client.query("begin");
        const status = await lockRunStatus(client, input.runId);
        const runTrace = await client.query<{ traceparent: string | null }>(
          "select traceparent from workflow_runs where id = $1",
          [input.runId],
        );
        const traceparent = runTrace.rows[0]?.traceparent ?? null;
        const existing = await client.query<{ first: string; last: string }>(
          `select first_sequence_number as first, last_sequence_number as last
           from workflow_task_results where run_id = $1 and task_key = $2`,
          [input.runId, input.taskKey],
        );
        const previous = existing.rows[0];
        if (previous !== undefined) {
          await client.query("commit");
          return {
            recorded: false,
            firstSequenceNumber: Number(previous.first),
            lastSequenceNumber: Number(previous.last),
          };
        }
        if (status !== undefined && isTerminalState(status)) {
          await client.query("commit");
          return {
            recorded: false,
            firstSequenceNumber: input.expectedSeq + 1,
            lastSequenceNumber: input.expectedSeq,
          };
        }
        const stored: StoredEvent[] = await appendEventsOnClient(
          client,
          codec,
          input.runId,
          input.expectedSeq,
          events,
        );
        for (const event of events) {
          if (event.type === "child_started") {
            const namespace = await client.query<{ namespace_id: string }>(
              "select namespace_id from workflow_runs where id = $1",
              [input.runId],
            );
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
                namespaceId: namespace.rows[0]?.namespace_id ?? "",
                queueName: recorderOptions.queueName,
                traceparent: childSpan.traceparent ?? traceparent,
              },
              event,
            );
            if (child.created) {
              pendingSpans.push(childSpan);
            }
          }
          if (event.type === "run_continued_as_new") {
            await createContinuedRunOnClient(client, codec, input.runId, event);
          }
          if (event.type === "step_scheduled" && recorderOptions.queueName !== undefined) {
            await enqueueStepTaskOnClient(client, {
              namespaceId: await readNamespaceId(client, input.runId),
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
        if (events.some((event) => CLOSING_EVENT_TYPES.has(event.type))) {
          await closeRunIfTerminal(client, codec, input.runId);
        }
        const firstSequenceNumber = input.expectedSeq + 1;
        const lastSequenceNumber = input.expectedSeq + stored.length;
        await client.query(
          `insert into workflow_task_results
             (run_id, task_key, first_sequence_number, last_sequence_number)
           values ($1, $2, $3, $4)`,
          [input.runId, input.taskKey, firstSequenceNumber, lastSequenceNumber],
        );
        await client.query("commit");
        const taskSpan = tracing.startSpan("workflow.task", {
          parent: traceparent,
          attributes: {
            "dee.run.id": input.runId,
            "dee.task.key": input.taskKey,
            "dee.events.count": stored.length,
          },
        });
        taskSpan.end();
        for (const span of pendingSpans) {
          span.end();
        }
        return { recorded: true, firstSequenceNumber, lastSequenceNumber };
      });
    },
  };
}
