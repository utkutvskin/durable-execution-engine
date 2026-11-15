import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { withTransaction } from "../db/transaction.ts";
import { startWorkflow } from "../embedded/transactional.ts";
import { createPostgresEventStore, type EventStore } from "../event-store/event-store.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { createResultRecorder, type ResultRecorder } from "../idempotency/recorder.ts";
import { commandToEvent } from "../workflow/command-events.ts";
import { runDecisionLoop, type DecisionResult } from "../workflow/decision-loop.ts";
import { defineWorkflow } from "../workflow/define-workflow.ts";
import type { ClockSource, RandomSource } from "../workflow/sources.ts";
import { InvalidSearchAttributesError } from "./search-attributes.ts";
import { compileVisibilityQuery } from "./visibility-query.ts";

const sources: { clock: ClockSource; random: RandomSource } = {
  clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  random: { random: () => 0.5, uuid: () => "fixed-uuid" },
};

interface RoundInput {
  readonly round: number;
}

const rounds = defineWorkflow("rounds", async (ctx, input: RoundInput) => {
  ctx.upsertSearchAttributes({ round: input.round, [`seen${String(input.round)}`]: true });
  await ctx.step("work", { round: input.round });
  if (input.round >= 3) {
    ctx.upsertSearchAttributes({ stage: "done", seen1: null });
    return input.round;
  }
  ctx.upsertSearchAttributes({ stage: "continuing" });
  return ctx.continueAsNew({ round: input.round + 1 });
});

interface RunRow {
  readonly id: string;
  readonly status: string;
  readonly search_attributes: Record<string, unknown>;
  readonly memo: unknown;
}

describe("search attributes and memo against postgres", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let recorder: ResultRecorder;
  let taskCounter = 0;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    recorder = createResultRecorder(database.pool, undefined, { queueName: "default" });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
  });

  async function start(input: RoundInput): Promise<string> {
    const started = await withTransaction(database.pool, (client) =>
      startWorkflow(client, {
        workflowType: "rounds",
        input,
        searchAttributes: { customerId: "c-1", priority: 2 },
        memo: { note: "first order" },
      }),
    );
    return started.runId;
  }

  async function history(runId: string): Promise<WorkflowEvent[]> {
    return (await store.read(runId)).map((stored) => stored.event);
  }

  async function row(runId: string): Promise<RunRow> {
    const result = await database.pool.query<RunRow>(
      "select id, status, search_attributes, memo from workflow_runs where id = $1",
      [runId],
    );
    const found = result.rows[0];
    if (found === undefined) {
      throw new Error(`run ${runId} not found`);
    }
    return found;
  }

  async function decideAndRecord(runId: string): Promise<DecisionResult> {
    const stored = await store.read(runId);
    const events = stored.map((entry) => entry.event);
    const started = events[0];
    const input = started?.type === "run_started" ? started.input : undefined;
    const decision = await runDecisionLoop(rounds.handler, input as RoundInput, events, sources);
    taskCounter += 1;
    await recorder.recordWorkflowTaskResult({
      runId,
      taskKey: `task-${String(taskCounter)}`,
      expectedSeq: stored.at(-1)?.sequenceNumber ?? 0,
      events: decision.commands.map(commandToEvent),
    });
    return decision;
  }

  async function completeOpenStep(runId: string): Promise<void> {
    const events = await history(runId);
    const scheduled = events.flatMap((event) =>
      event.type === "step_scheduled" ? [event.stepId] : [],
    );
    const done = new Set(
      events.flatMap((event) => (event.type === "step_completed" ? [event.stepId] : [])),
    );
    for (const stepId of scheduled) {
      if (!done.has(stepId)) {
        await recorder.recordStepResult({
          runId,
          stepId,
          attemptKey: `${stepId}-1`,
          outcome: { status: "completed", result: null },
        });
      }
    }
  }

  async function currentRunOf(runId: string): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      "select id from workflow_runs where continued_from_run_id = $1",
      [runId],
    );
    return result.rows[0]?.id ?? runId;
  }

  it("stores the attributes and memo a run starts with on its row and its run_started event", async () => {
    const runId = await start({ round: 1 });
    expect(await row(runId)).toMatchObject({
      search_attributes: { customerId: "c-1", priority: 2 },
      memo: { note: "first order" },
    });
    expect((await history(runId))[0]).toEqual({
      type: "run_started",
      workflowType: "rounds",
      input: { round: 1 },
      searchAttributes: { customerId: "c-1", priority: 2 },
      memo: { note: "first order" },
    });
  });

  it("refuses invalid attributes before writing anything", async () => {
    await expect(
      withTransaction(database.pool, (client) =>
        startWorkflow(client, { workflowType: "rounds", searchAttributes: { status: "x" } }),
      ),
    ).rejects.toThrow(InvalidSearchAttributesError);
    const runs = await database.pool.query("select 1 from workflow_runs");
    expect(runs.rowCount).toBe(0);
  });

  it("applies an upsert to the row when the decision is recorded, and a replay leaves it alone", async () => {
    const runId = await start({ round: 3 });
    await decideAndRecord(runId);
    expect((await row(runId)).search_attributes).toEqual({
      customerId: "c-1",
      priority: 2,
      round: 3,
      seen3: true,
    });
    const replayed = await runDecisionLoop(
      rounds.handler,
      { round: 3 },
      await history(runId),
      sources,
    );
    expect(replayed.commands).toEqual([]);
    await completeOpenStep(runId);
    await decideAndRecord(runId);
    const closed = await row(runId);
    expect(closed.status).toBe("COMPLETED");
    expect(closed.search_attributes).toEqual({
      customerId: "c-1",
      priority: 2,
      round: 3,
      seen3: true,
      stage: "done",
    });
  });

  it("carries the attributes, their upserts and the memo across continue-as-new", async () => {
    let runId = await start({ round: 1 });
    const chain = [runId];
    for (let decisions = 0; decisions < 12; decisions += 1) {
      const decision = await decideAndRecord(runId);
      if (decision.outcome === "completed") {
        break;
      }
      if (decision.outcome === "continued_as_new") {
        runId = await currentRunOf(runId);
        chain.push(runId);
        continue;
      }
      await completeOpenStep(runId);
    }
    expect(chain).toHaveLength(3);
    const first = await row(chain[0] ?? "");
    expect(first.status).toBe("CONTINUED_AS_NEW");
    expect(first.search_attributes).toMatchObject({ round: 1, stage: "continuing" });
    const second = await history(chain[1] ?? "");
    expect(second[0]).toMatchObject({
      type: "run_started",
      searchAttributes: {
        customerId: "c-1",
        priority: 2,
        round: 1,
        seen1: true,
        stage: "continuing",
      },
      memo: { note: "first order" },
    });
    const last = await row(chain[2] ?? "");
    expect(last.status).toBe("COMPLETED");
    expect(last.memo).toEqual({ note: "first order" });
    expect(last.search_attributes).toEqual({
      customerId: "c-1",
      priority: 2,
      round: 3,
      seen2: true,
      seen3: true,
      stage: "done",
    });
  });

  it("finds runs with a compiled query, and binds a hostile value instead of running it", async () => {
    const insert = async (attributes: Record<string, unknown>, status: string): Promise<string> => {
      const runId = await start({ round: 1 });
      await database.pool.query(
        "update workflow_runs set search_attributes = $2::jsonb, status = $3 where id = $1",
        [runId, JSON.stringify(attributes), status],
      );
      return runId;
    };
    const wanted = await insert({ customerId: "c-1", amount: 50 }, "FAILED");
    await insert({ customerId: "c-1", amount: 5 }, "FAILED");
    await insert({ customerId: "c-2", amount: 50 }, "FAILED");
    await insert({ customerId: "c-1", amount: "50" }, "FAILED");
    await insert({ customerId: "c-1", amount: 50 }, "COMPLETED");
    const search = async (query: string): Promise<string[]> => {
      const compiled = compileVisibilityQuery(query, 1);
      const result = await database.pool.query<{ id: string }>(
        `select id from workflow_runs where ${compiled.sql} order by id`,
        [...compiled.values],
      );
      return result.rows.map((found) => found.id);
    };
    expect(await search("status = 'FAILED' and customerId = 'c-1' and amount > 10")).toEqual([
      wanted,
    ]);
    expect(await search("customerId = 'x'' or 1=1; drop table tasks; --'")).toEqual([]);
    expect(await search("not amount > 10 and customerId = 'c-1'")).toHaveLength(2);
    const tables = await database.pool.query("select 1 from tasks limit 1");
    expect(tables.command).toBe("SELECT");
  });
});
