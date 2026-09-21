import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "./test-harness.js";

describe("initial schema", () => {
  let database: IsolatedSchema;

  beforeEach(async () => {
    database = await createIsolatedDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  it("rejects a second run_events row with the same (run_id, sequence_number)", async () => {
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('acme') returning id",
    );
    const namespaceId = namespace.rows[0]?.id;
    expect(namespaceId).toBeDefined();

    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'ship-order') returning id",
      [namespaceId],
    );
    const runId = run.rows[0]?.id;
    expect(runId).toBeDefined();

    await database.pool.query(
      "insert into run_events (run_id, sequence_number, event_type) values ($1, 1, 'run_started')",
      [runId],
    );

    await expect(
      database.pool.query(
        "insert into run_events (run_id, sequence_number, event_type) values ($1, 1, 'run_started')",
        [runId],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("defines tasks_state_visible_at_idx as a partial index on (state, visible_at)", async () => {
    const result = await database.pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = $1 and indexname = 'tasks_state_visible_at_idx'",
      [database.schema],
    );
    expect(result.rows).toHaveLength(1);
    const indexdef = result.rows[0]?.indexdef ?? "";
    expect(indexdef).toMatch(/\(state, visible_at\)/);
    expect(indexdef).toMatch(/WHERE \(state = 'PENDING'::text\)/);
  });

  it("creates all six tables named by day 2's scope", async () => {
    const result = await database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name != 'schema_migrations'
       order by table_name`,
      [database.schema],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "namespaces",
      "run_events",
      "step_results",
      "tasks",
      "timers",
      "workflow_runs",
    ]);
  });
});
