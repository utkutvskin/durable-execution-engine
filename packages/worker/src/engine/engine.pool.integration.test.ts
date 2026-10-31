import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, defineStep, defineWorkflow, type Pool } from "@dee/core";
import { createRunService } from "../../../api/src/index.js";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { startEngine } from "./runtime.js";

describe("engine on a small connection pool", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
    pool = createPool(process.env, {
      schema: database.schema,
      max: 3,
      acquireTimeoutMillis: 20_000,
    });
  });

  afterAll(async () => {
    await pool.end();
    await database.close();
  });

  it("completes 50 runs with twice as many workers as connections and no deadlock", async () => {
    const double = defineStep<{ value: number }, number>("double", {
      handler: ({ value }) => value * 2,
    });
    const flow = defineWorkflow("flow", async (ctx, input: { value: number }) => {
      const first = await ctx.step<number>("double", input);
      return ctx.step<number>("double", { value: first });
    });
    const errors: unknown[] = [];
    const engine = startEngine({
      pool,
      workflows: [flow],
      steps: [double],
      concurrency: 6,
      pollIntervalMs: 5,
      loopIntervalMs: 50,
      shutdownTimeoutMs: 5_000,
      onError: (error) => {
        errors.push(error);
      },
    });
    const service = createRunService(pool, { queueName: "default" });
    const runIds: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const started = await service.startRun(namespaceId, {
        workflowType: "flow",
        input: { value: index },
      });
      runIds.push(started.run.runId);
    }

    let completed = 0;
    for (let attempt = 0; attempt < 2000 && completed < runIds.length; attempt += 1) {
      const result = await pool.query<{ n: string }>(
        "select count(*) as n from workflow_runs where status = 'COMPLETED'",
      );
      completed = Number(result.rows[0]?.n);
      if (completed < runIds.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    await engine.stop();

    expect(completed).toBe(50);
    expect(errors).toEqual([]);
    const stepResults = await pool.query<{ n: string }>("select count(*) as n from step_results");
    expect(Number(stepResults.rows[0]?.n)).toBe(100);
  }, 60_000);
});
