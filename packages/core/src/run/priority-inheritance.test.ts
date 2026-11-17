import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChildRunOnClient } from "../children/child-runs.ts";
import { createContinuedRunOnClient } from "../continuation/continued-run.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { jsonCodec } from "../event-store/codec.ts";
import { insertRunOnClient } from "./insert-run.ts";
import { InvalidPriorityError } from "./priority.ts";

interface PriorityRow {
  run: number;
  tasks: number[];
}

describe("run priority inheritance", () => {
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
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async function startParent(priority: number): Promise<string> {
    const runId = await inTransaction((client) =>
      insertRunOnClient(client, jsonCodec, {
        namespaceId,
        workflowType: "parent",
        input: null,
        queueName: "default",
        priority,
      }),
    );
    if (runId === undefined) {
      throw new Error("the parent run was not created");
    }
    return runId;
  }

  async function priorities(runId: string): Promise<PriorityRow> {
    const result = await database.pool.query<PriorityRow>(
      `select r.priority as run,
              array(select t.priority from tasks t where t.run_id = r.id order by t.created_at) as tasks
       from workflow_runs r where r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`run ${runId} does not exist`);
    }
    return row;
  }

  it("starts a run and its first task with the priority it was given", async () => {
    const runId = await startParent(-20);
    expect(await priorities(runId)).toEqual({ run: -20, tasks: [-20] });
  });

  it("gives a child run and its tasks the parent's priority", async () => {
    const parentId = await startParent(42);
    const child = await inTransaction((client) =>
      createChildRunOnClient(
        client,
        jsonCodec,
        { runId: parentId, namespaceId, queueName: "default" },
        {
          type: "child_started",
          childId: "child-1",
          workflowType: "child",
          input: {},
          parentClosePolicy: "terminate",
        },
      ),
    );
    expect(child.created).toBe(true);
    expect(await priorities(child.runId)).toEqual({ run: 42, tasks: [42] });
  });

  it("keeps the priority across continue-as-new", async () => {
    const firstId = await startParent(9);
    const nextId = await inTransaction((client) =>
      createContinuedRunOnClient(client, jsonCodec, firstId, {
        type: "run_continued_as_new",
        input: { page: 2 },
      }),
    );
    expect(await priorities(nextId)).toEqual({ run: 9, tasks: [9] });
  });

  it("refuses a priority out of range before writing anything", async () => {
    await expect(startParent(5000)).rejects.toBeInstanceOf(InvalidPriorityError);
    const runs = await database.pool.query("select 1 from workflow_runs");
    expect(runs.rowCount).toBe(0);
  });
});
