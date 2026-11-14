import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findCurrentRun, readRunChain } from "../continuation/run-chain.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { ConcurrencyError } from "../event-store/errors.ts";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.ts";
import { commandToEvent } from "../workflow/command-events.ts";
import { runDecisionLoop } from "../workflow/decision-loop.ts";
import { defineWorkflow } from "../workflow/define-workflow.ts";
import type { ClockSource, RandomSource } from "../workflow/sources.ts";
import { createWorkflowRegistry } from "../workflow/workflow-registry.ts";
import {
  RunNotOpenError,
  WorkflowKeyConflictError,
  createRunInteractions,
  type RunInteractions,
} from "./signal-service.ts";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

interface InboxInput {
  readonly seen: readonly number[];
  readonly target: number;
}

const inbox = defineWorkflow("inbox", async (ctx, input: InboxInput) => {
  const seen = [...input.seen];
  for (let round = 0; round < 2 && seen.length < input.target; round += 1) {
    seen.push(await ctx.waitForSignal<number>("item"));
  }
  if (seen.length >= input.target) {
    return seen;
  }
  return ctx.continueAsNew({ seen, target: input.target });
});

describe("signal semantics against postgres", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let interactions: RunInteractions;
  let namespaceId: string;
  let taskCounter = 0;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: "default" });
    const workflows = createWorkflowRegistry();
    workflows.register(inbox);
    interactions = createRunInteractions(database.pool, { workflows, ...sources });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from signal_ids");
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("update workflow_runs set continued_from_run_id = null");
    await database.pool.query("delete from workflow_runs");
    await database.pool.query("delete from namespaces");
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  async function startRun(input: InboxInput): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, input) values ($1, 'inbox', $2::jsonb) returning id",
      [namespaceId, JSON.stringify(input)],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [{ type: "run_started", workflowType: "inbox", input }]);
    return runId;
  }

  async function history(runId: string): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function decideOnce(runId: string): Promise<string> {
    const recorded = await history(runId);
    const started = recorded[0];
    const input = (started?.type === "run_started" ? started.input : {}) as InboxInput;
    const decision = await runDecisionLoop(inbox.handler, input, recorded, sources);
    taskCounter += 1;
    try {
      await recorder.recordWorkflowTaskResult({
        runId,
        taskKey: `task-${String(taskCounter)}`,
        expectedSeq: recorded.length,
        events: decision.commands.map(commandToEvent),
      });
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        return "retry";
      }
      throw error;
    }
    return decision.outcome;
  }

  async function driveChain(firstRunId: string): Promise<void> {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const current = await findCurrentRun(database.pool, firstRunId);
      if (current === undefined) {
        throw new Error("the chain has no current run");
      }
      if (current.status === "COMPLETED") {
        return;
      }
      await decideOnce(current.runId);
    }
    throw new Error("the chain did not complete");
  }

  it("records a signal with a repeated id once and returns the first receipt", async () => {
    const runId = await startRun({ seen: [], target: 5 });

    const first = await interactions.signalRun(runId, "item", 1, { signalId: "pay-1" });
    const second = await interactions.signalRun(runId, "item", 1, { signalId: "pay-1" });
    const other = await interactions.signalRun(runId, "item", 2, { signalId: "pay-2" });

    expect(first).toEqual({ runId, sequenceNumber: 2, duplicate: false });
    expect(second).toEqual({ runId, sequenceNumber: 2, duplicate: true });
    expect(other.duplicate).toBe(false);
    const signals = (await history(runId)).filter((event) => event.type === "signal_received");
    expect(signals).toEqual([
      { type: "signal_received", signalName: "item", payload: 1, signalId: "pay-1" },
      { type: "signal_received", signalName: "item", payload: 2, signalId: "pay-2" },
    ]);
    const tasks = await database.pool.query("select 1 from tasks where run_id = $1", [runId]);
    expect(tasks.rowCount).toBe(2);
  });

  it("applies a signal id once under 10 concurrent sends", async () => {
    const runId = await startRun({ seen: [], target: 5 });

    const receipts = await Promise.all(
      Array.from({ length: 10 }, () =>
        interactions.signalRun(runId, "item", 7, { signalId: "same" }),
      ),
    );

    expect(receipts.filter((receipt) => !receipt.duplicate)).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.sequenceNumber))).toEqual(new Set([2]));
    const signals = (await history(runId)).filter((event) => event.type === "signal_received");
    expect(signals).toHaveLength(1);
  });

  it("creates exactly one run under 20 concurrent signal-with-start calls", async () => {
    const receipts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        interactions.signalWithStart({
          namespaceId,
          workflowType: "inbox",
          workflowKey: "customer-7",
          input: { seen: [], target: 20 },
          signalName: "item",
          payload: index,
        }),
      ),
    );

    const runs = await database.pool.query<{ id: string }>(
      "select id from workflow_runs where idempotency_key = 'customer-7'",
    );
    expect(runs.rows).toHaveLength(1);
    const runId = runs.rows[0]?.id ?? "";
    expect(receipts.filter((receipt) => receipt.created)).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.runId))).toEqual(new Set([runId]));
    const events = await history(runId);
    expect(events[0]).toMatchObject({ type: "run_started", workflowType: "inbox" });
    const payloads = events.flatMap((event) =>
      event.type === "signal_received" ? [event.payload as number] : [],
    );
    expect(payloads.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(new Set(receipts.map((receipt) => receipt.sequenceNumber)).size).toBe(20);
  });

  it("refuses signal-with-start for a key that holds another workflow type", async () => {
    await interactions.signalWithStart({
      namespaceId,
      workflowType: "inbox",
      workflowKey: "taken",
      input: { seen: [], target: 1 },
      signalName: "item",
      payload: 1,
    });

    await expect(
      interactions.signalWithStart({
        namespaceId,
        workflowType: "other",
        workflowKey: "taken",
        signalName: "item",
      }),
    ).rejects.toBeInstanceOf(WorkflowKeyConflictError);
  });

  it("carries unconsumed signals into the next run, keeping their ids", async () => {
    const firstRunId = await startRun({ seen: [], target: 4 });
    for (const value of [1, 2, 3]) {
      await interactions.signalRun(firstRunId, "item", value, { signalId: `s-${String(value)}` });
    }

    expect(await decideOnce(firstRunId)).toBe("continued_as_new");

    const chain = await readRunChain(database.pool, firstRunId);
    const next = chain[1]?.runId ?? "";
    expect(await history(next)).toEqual([
      { type: "run_started", workflowType: "inbox", input: { seen: [1, 2], target: 4 } },
      { type: "signal_received", signalName: "item", payload: 3, signalId: "s-3" },
    ]);
    const replayed = await interactions.signalRun(firstRunId, "item", 3, { signalId: "s-3" });
    expect(replayed.duplicate).toBe(true);
    const forwarded = await interactions.signalRun(firstRunId, "item", 4);
    expect(forwarded).toMatchObject({ runId: next, duplicate: false });
  });

  it("loses no signal across continue-as-new while 30 signals arrive concurrently", async () => {
    const target = 30;
    const firstRunId = await startRun({ seen: [], target });

    await Promise.all([
      Promise.all(
        Array.from({ length: target }, (_, index) =>
          interactions.signalRun(firstRunId, "item", index),
        ),
      ),
      driveChain(firstRunId),
    ]);

    const chain = await readRunChain(database.pool, firstRunId);
    const last = chain.at(-1);
    expect(last?.status).toBe("COMPLETED");
    expect(chain.length).toBeGreaterThan(1);
    const result = last?.result as number[];
    expect([...result].sort((a, b) => a - b)).toEqual(Array.from({ length: target }, (_, i) => i));
  });

  it("still refuses a signal for a chain whose last run is closed", async () => {
    const runId = await startRun({ seen: [], target: 1 });
    await interactions.signalRun(runId, "item", 1);
    await driveChain(runId);

    await expect(interactions.signalRun(runId, "item", 2)).rejects.toBeInstanceOf(RunNotOpenError);
  });
});
