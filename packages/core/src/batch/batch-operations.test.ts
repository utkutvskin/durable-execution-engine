import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { withTransaction } from "../db/transaction.ts";
import { jsonCodec } from "../event-store/codec.ts";
import { insertRunOnClient } from "../run/insert-run.ts";
import { VisibilityQueryError } from "../visibility/visibility-query.ts";
import {
  BATCH_WORKFLOW_TYPE,
  InvalidBatchOperationError,
  listBatchOperations,
  listBatchTargets,
  planBatchPages,
  readBatchOperation,
  startBatchOperationOnClient,
  type StartBatchInput,
} from "./batch-operations.ts";

describe("batch pages", () => {
  it("applies pages back to back without a rate", () => {
    expect(planBatchPages(undefined)).toEqual({ pageSize: 100, pageIntervalMs: 0 });
    expect(planBatchPages(undefined, 7)).toEqual({ pageSize: 7, pageIntervalMs: 0 });
  });

  it("sizes the pages and the pause between them to the rate", () => {
    expect(planBatchPages(10)).toEqual({ pageSize: 10, pageIntervalMs: 1000 });
    expect(planBatchPages(250)).toEqual({ pageSize: 100, pageIntervalMs: 400 });
    expect(planBatchPages(0.5)).toEqual({ pageSize: 1, pageIntervalMs: 2000 });
  });

  it("rejects a rate or a page size out of range", () => {
    expect(() => planBatchPages(0)).toThrow(InvalidBatchOperationError);
    expect(() => planBatchPages(Number.NaN)).toThrow(InvalidBatchOperationError);
    expect(() => planBatchPages(undefined, 0)).toThrow(/pageSize/);
    expect(() => planBatchPages(undefined, 1001)).toThrow(/pageSize/);
  });
});

describe("starting a batch operation", () => {
  let database: IsolatedSchema;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("truncate namespaces cascade");
    const created = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
  });

  async function startRun(kind: string): Promise<string> {
    return withTransaction(database.pool, async (client) => {
      const runId = await insertRunOnClient(client, jsonCodec, {
        namespaceId,
        workflowType: "order",
        input: {},
        queueName: "default",
        searchAttributes: { kind },
      });
      return runId ?? "";
    });
  }

  function start(input: Partial<StartBatchInput>) {
    return withTransaction(database.pool, (client) =>
      startBatchOperationOnClient(client, jsonCodec, {
        namespaceId,
        operation: "terminate",
        query: "",
        queueName: "default",
        ...input,
      }),
    );
  }

  it("snapshots the matching runs oldest first and starts its workflow run", async () => {
    const first = await startRun("red");
    await startRun("blue");
    const third = await startRun("red");

    const batch = await start({ query: "kind = 'red'", reason: "cleanup" });
    await startRun("red");

    expect(batch).toMatchObject({ total: 2, remaining: 2, operation: "terminate" });
    const targets = await listBatchTargets(database.pool, batch.batchId);
    expect(targets.map((target) => [target.position, target.runId, target.state])).toEqual([
      [1, first, "PENDING"],
      [2, third, "PENDING"],
    ]);
    const run = await database.pool.query<{ workflow_type: string; input: unknown }>(
      "select workflow_type, input from workflow_runs where id = $1",
      [batch.runId],
    );
    expect(run.rows).toEqual([
      { workflow_type: BATCH_WORKFLOW_TYPE, input: { batchId: batch.batchId } },
    ]);
    expect(await readBatchOperation(database.pool, batch.batchId)).toMatchObject({
      status: "RUNNING",
      reason: "cleanup",
      total: 2,
    });
    expect(
      (await listBatchOperations(database.pool, namespaceId)).map((entry) => entry.batchId),
    ).toEqual([batch.batchId]);
  });

  it("rejects a signal batch without a name, a reset batch without a point and an unknown operation", async () => {
    await expect(start({ operation: "signal" })).rejects.toThrow(/needs a signal name/);
    await expect(start({ operation: "signal", signal: { name: "" } })).rejects.toThrow(
      InvalidBatchOperationError,
    );
    await expect(start({ operation: "reset" })).rejects.toThrow(/needs a reset point/);
    await expect(
      start({ operation: "reset", resetPoint: { kind: "step", step: 0 } }),
    ).rejects.toThrow(/positive integer/);
    await expect(start({ operation: "delete" as never })).rejects.toThrow(/unknown batch/);
  });

  it("writes nothing when the query does not parse", async () => {
    await startRun("red");
    await expect(start({ query: "kind = " })).rejects.toBeInstanceOf(VisibilityQueryError);
    const batches = await database.pool.query("select 1 from batch_operations");
    const runs = await database.pool.query("select 1 from workflow_runs where workflow_type = $1", [
      BATCH_WORKFLOW_TYPE,
    ]);
    expect(batches.rowCount).toBe(0);
    expect(runs.rowCount).toBe(0);
  });

  it("reads no batch of another namespace", async () => {
    const batch = await start({});
    const other = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('other') returning id",
    );
    expect(
      await readBatchOperation(database.pool, batch.batchId, other.rows[0]?.id),
    ).toBeUndefined();
    expect(await readBatchOperation(database.pool, batch.batchId, namespaceId)).toBeDefined();
  });
});
