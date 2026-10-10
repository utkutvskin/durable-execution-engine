import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findCurrentRun, readRunChain } from "../continuation/run-chain.js";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.js";
import { ConcurrencyError } from "../event-store/errors.js";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.js";
import type { WorkflowEvent } from "../event-store/events.js";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.js";
import { rebuildProjection } from "../run/projection-store.js";
import type { ClockSource } from "../workflow/sources.js";
import { createHistoryCompactor, type HistoryCompactor } from "./history-compactor.js";
import { readSnapshotOnClient } from "./snapshot.js";

const HOUR_MS = 3_600_000;

describe("history compaction", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let namespaceId: string;
  let nowMs: number;
  const clock: ClockSource = { now: () => new Date(nowMs) };

  function compactor(closedRunRetentionMs: number, tailEvents = 0): HistoryCompactor {
    return createHistoryCompactor(database.pool, {
      clock,
      policy: { closedRunRetentionMs, tailEvents },
    });
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: "default" });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    nowMs = Date.now() + 48 * HOUR_MS;
    await database.pool.query("delete from run_snapshots");
    await database.pool.query("delete from workflow_task_results");
    await database.pool.query("delete from step_results");
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

  async function runWithSteps(stepCount: number, closing?: WorkflowEvent): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type, input) values ($1, 'work', '{\"n\":1}'::jsonb) returning id",
      [namespaceId],
    );
    const runId = run.rows[0]?.id ?? "";
    const events: WorkflowEvent[] = [
      { type: "run_started", workflowType: "work", input: { n: 1 } },
    ];
    for (let index = 1; index <= stepCount; index += 1) {
      const stepId = `step-${String(index)}`;
      events.push(
        { type: "step_scheduled", stepId, stepType: "add", input: { value: index } },
        { type: "step_completed", stepId, result: index },
      );
    }
    await store.append(runId, 0, events);
    await database.pool.query(
      `insert into tasks (namespace_id, run_id, queue_name, task_type)
       values ($1, $2, 'default', 'WORKFLOW_TASK')`,
      [namespaceId, runId],
    );
    if (closing !== undefined) {
      await recorder.recordWorkflowTaskResult({
        runId,
        taskKey: "close",
        expectedSeq: events.length,
        events: [closing],
      });
    }
    return runId;
  }

  async function eventCount(runId: string): Promise<number> {
    const row = await database.pool.query<{ count: string }>(
      "select count(*) from run_events where run_id = $1",
      [runId],
    );
    return Number(row.rows[0]?.count ?? "0");
  }

  async function projectionRow(runId: string): Promise<unknown> {
    const row = await database.pool.query(
      `select status, input, result, error, closed_at, last_sequence_number
       from workflow_runs where id = $1`,
      [runId],
    );
    return row.rows[0];
  }

  it("leaves a running run untouched whatever its age", async () => {
    const runId = await runWithSteps(5);

    const result = await compactor(0).compactRun(runId);

    expect(result).toEqual({ runId, compacted: false, prunedEvents: 0 });
    expect(await eventCount(runId)).toBe(11);
  });

  it("prunes a closed run's events and keeps the projection identical when rebuilt from the snapshot", async () => {
    const runId = await runWithSteps(20, { type: "run_completed", result: 210 });
    const before = await projectionRow(runId);

    const result = await compactor(HOUR_MS).compactRun(runId);
    const rebuilt = await rebuildProjection(database.pool, store, runId);

    expect(result.compacted).toBe(true);
    expect(result.prunedEvents).toBe(42);
    expect(await eventCount(runId)).toBe(0);
    expect(rebuilt).toMatchObject({
      state: "COMPLETED",
      result: 210,
      input: { n: 1 },
      lastSequenceNumber: 42,
    });
    expect(await projectionRow(runId)).toEqual(before);
  });

  it("keeps the configured tail and rebuilds from snapshot plus tail to the same projection", async () => {
    const runId = await runWithSteps(10, { type: "run_completed", result: 55 });
    const before = await projectionRow(runId);

    const result = await compactor(HOUR_MS, 3).compactRun(runId);
    const rebuilt = await rebuildProjection(database.pool, store, runId);

    expect(result.prunedEvents).toBe(19);
    expect(await eventCount(runId)).toBe(3);
    expect((await store.read(runId)).map((stored) => stored.sequenceNumber)).toEqual([20, 21, 22]);
    expect(result.snapshot?.projection.state).toBe("RUNNING");
    expect(rebuilt.state).toBe("COMPLETED");
    expect(rebuilt.lastSequenceNumber).toBe(22);
    expect(await projectionRow(runId)).toEqual(before);
  });

  it("stores the snapshot with its sequence and the number of events it replaced", async () => {
    const runId = await runWithSteps(4, { type: "run_failed", error: { name: "E", message: "m" } });

    await compactor(HOUR_MS).compactRun(runId);

    const client = await database.pool.connect();
    try {
      const snapshot = await readSnapshotOnClient(client, runId);
      expect(snapshot).toMatchObject({
        runId,
        lastSequenceNumber: 10,
        prunedEventCount: 10,
        projection: { state: "FAILED", error: { name: "E", message: "m" } },
      });
      expect(snapshot?.projection.closedAt).toBeInstanceOf(Date);
    } finally {
      client.release();
    }
  });

  it("prunes nothing the second time a run is compacted", async () => {
    const runId = await runWithSteps(3, { type: "run_completed", result: 6 });
    const policyCompactor = compactor(HOUR_MS);

    const first = await policyCompactor.compactRun(runId);
    const second = await policyCompactor.compactRun(runId);

    expect(first.prunedEvents).toBe(8);
    expect(second).toMatchObject({ compacted: true, prunedEvents: 0 });
    expect((await rebuildProjection(database.pool, store, runId)).result).toBe(6);
  });

  it("refuses an append to a pruned run instead of restarting its sequence at one", async () => {
    const runId = await runWithSteps(2, { type: "run_completed", result: 3 });
    await compactor(HOUR_MS).compactRun(runId);

    await expect(store.append(runId, 0, [{ type: "cancel_requested" }])).rejects.toBeInstanceOf(
      ConcurrencyError,
    );
    expect(await eventCount(runId)).toBe(0);
  });

  it("sweeps only closed runs older than the retention, oldest first, and reports the totals", async () => {
    const oldRun = await runWithSteps(2, { type: "run_completed", result: 3 });
    const young = await runWithSteps(2, { type: "run_completed", result: 3 });
    const open = await runWithSteps(2);
    await database.pool.query("update workflow_runs set closed_at = $2 where id = $1", [
      young,
      new Date(nowMs - HOUR_MS / 2),
    ]);
    await database.pool.query("update workflow_runs set closed_at = $2 where id = $1", [
      oldRun,
      new Date(nowMs - 3 * HOUR_MS),
    ]);

    const report = await compactor(HOUR_MS).sweep();

    expect(report).toEqual({ runsCompacted: 1, eventsPruned: 6 });
    expect(await eventCount(oldRun)).toBe(0);
    expect(await eventCount(young)).toBe(6);
    expect(await eventCount(open)).toBe(5);
    expect(await compactor(HOUR_MS).sweep()).toEqual({ runsCompacted: 0, eventsPruned: 0 });
  });

  it("honours the batch size so a large backlog is compacted over several sweeps", async () => {
    const runIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      runIds.push(await runWithSteps(1, { type: "run_completed", result: index }));
    }
    const sweeper = compactor(0);

    const reports = [await sweeper.sweep(2), await sweeper.sweep(2), await sweeper.sweep(2)];

    expect(reports.map((report) => report.runsCompacted)).toEqual([2, 2, 1]);
    for (const runId of runIds) {
      expect(await eventCount(runId)).toBe(0);
    }
  });

  it("keeps the chain query working after the old runs of a chain were pruned", async () => {
    const firstRunId = await runWithSteps(2, { type: "run_continued_as_new", input: { n: 2 } });
    const chainBefore = await readRunChain(database.pool, firstRunId);
    const second = chainBefore[1]?.runId ?? "";
    await recorder.recordWorkflowTaskResult({
      runId: second,
      taskKey: "finish",
      expectedSeq: 1,
      events: [{ type: "run_completed", result: "done" }],
    });

    const report = await compactor(HOUR_MS).sweep();
    const chainAfter = await readRunChain(database.pool, firstRunId);

    expect(report.runsCompacted).toBe(2);
    expect(chainAfter).toEqual(
      chainBefore.map((run) => ({
        ...run,
        ...(run.runId === second
          ? { status: "COMPLETED", result: "done", closedAt: chainAfter[1]?.closedAt }
          : {}),
      })),
    );
    expect((await findCurrentRun(database.pool, firstRunId))?.status).toBe("COMPLETED");
  });

  it("rejects a retention policy that is negative or has a fractional tail", () => {
    expect(() => compactor(-1)).toThrow(RangeError);
    expect(() => compactor(HOUR_MS, 1.5)).toThrow(RangeError);
    expect(() => compactor(HOUR_MS, -1)).toThrow(RangeError);
  });
});
