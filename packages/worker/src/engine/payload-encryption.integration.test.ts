import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEncryptionCodec,
  defineStep,
  defineWorkflow,
  type EncryptionKey,
  type PayloadCodec,
  type Pool,
} from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createWorkflowRegistry } from "../../../core/src/workflow/workflow-registry.ts";
import { createShiftableClock } from "../chaos/world.ts";
import { startEngine, type Engine } from "./runtime.ts";

const SECRET = "plaintext-marker-7f3a";

const keyOne: EncryptionKey = { id: "k1", key: randomBytes(32) };
const keyTwo: EncryptionKey = { id: "k2", key: randomBytes(32) };

const charge = defineStep<{ card: string }, { receipt: string }>("charge", {
  handler: ({ card }, context) => {
    context.heartbeat({ progress: `${card} halfway` });
    return { receipt: `${card} charged` };
  },
});

const child = defineWorkflow("receipt-child", async (ctx, input: { note: string }) => {
  const charged = await ctx.step<{ receipt: string }>("charge", { card: input.note });
  return { childResult: charged.receipt };
});

const checkout = defineWorkflow("checkout", async (ctx, input: { card: string }) => {
  let last = "";
  ctx.setQueryHandler("last", () => last);
  const charged = await ctx.step<{ receipt: string }>("charge", { card: input.card });
  last = charged.receipt;
  const approval = await ctx.waitForSignal<{ by: string }>("approve");
  const fromChild = await ctx.executeChild<{ childResult: string }>("receipt-child", {
    note: `${approval.by} child`,
  });
  return { receipt: charged.receipt, approvedBy: approval.by, child: fromChild.childResult };
});

describe("payload encryption", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let namespaceId: string;
  let engine: Engine | undefined;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await pool.query("truncate namespaces cascade");
    const namespace = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  function boot(payloadCodec: PayloadCodec): RunService {
    engine = startEngine({
      pool,
      workflows: [checkout, child],
      steps: [charge],
      payloadCodec,
      clock: createShiftableClock(),
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      concurrency: 4,
      stalledRunGraceMs: 60_000,
      shutdownTimeoutMs: 2_000,
    });
    return createRunService(pool, {
      queueName: "default",
      payloadCodec,
      workflows: registry(),
    });
  }

  function registry(): ReturnType<typeof createWorkflowRegistry> {
    const workflows = createWorkflowRegistry();
    workflows.register(checkout);
    workflows.register(child);
    return workflows;
  }

  async function status(runId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.status ?? "missing";
  }

  async function until(check: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      if (await check()) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition was not reached");
  }

  async function eventCount(runId: string, type: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "select count(*) as count from run_events where run_id = $1 and event_type = $2",
      [runId, type],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function tablesHolding(marker: string): Promise<string[]> {
    const tables = await pool.query<{ name: string }>(
      `select table_name as name from information_schema.tables
       where table_schema = current_schema() and table_type = 'BASE TABLE'
       order by table_name`,
    );
    const holding: string[] = [];
    for (const { name } of tables.rows) {
      const found = await pool.query(
        `select 1 from ${JSON.stringify(name)} row_value where row_value::text like $1 limit 1`,
        [`%${marker}%`],
      );
      if (found.rowCount !== null && found.rowCount > 0) {
        holding.push(name);
      }
    }
    return holding;
  }

  async function storedResult(runId: string): Promise<unknown> {
    const result = await pool.query<{ result: unknown }>(
      "select result from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.result;
  }

  it("leaves no plaintext payload in any row of any table", async () => {
    const codec = createEncryptionCodec({ keys: [keyOne], activeKeyId: "k1" });
    const service = boot(codec);
    const started = await service.startRun(namespaceId, {
      workflowType: "checkout",
      input: { card: `${SECRET}-card` },
    });
    const runId = started.run.runId;
    await until(async () => (await eventCount(runId, "step_completed")) === 1);
    expect(await service.queryRun(namespaceId, runId, "last")).toBe(`${SECRET}-card charged`);
    await service.signalRun(namespaceId, runId, "approve", { by: `${SECRET}-approver` });
    await until(async () => (await status(runId)) !== "RUNNING");
    await service.sendEvent(namespaceId, {
      eventName: "shipped",
      key: "order-1",
      payload: { tracking: `${SECRET}-tracking` },
    });
    await service.createSchedule(namespaceId, {
      name: "nightly",
      cronExpression: "0 0 * * *",
      workflowType: "checkout",
      input: { card: `${SECRET}-scheduled` },
    });

    expect(await status(runId)).toBe("COMPLETED");
    expect(codec.decode(await storedResult(runId))).toEqual({
      receipt: `${SECRET}-card charged`,
      approvedBy: `${SECRET}-approver`,
      child: `${SECRET}-approver child charged`,
    });
    const tables = await pool.query<{ count: string }>(
      `select count(*) as count from information_schema.tables
       where table_schema = current_schema() and table_type = 'BASE TABLE'`,
    );
    expect(Number(tables.rows[0]?.count)).toBeGreaterThan(20);
    expect(await tablesHolding(SECRET)).toEqual([]);
    expect(await tablesHolding("aes-256-gcm")).toEqual(
      expect.arrayContaining([
        "external_events",
        "run_events",
        "schedules",
        "step_heartbeats",
        "step_results",
        "workflow_runs",
      ]),
    );
  });

  it("stores a run in clear text without a codec, which the scan detects", async () => {
    const plain = createRunService(pool, { queueName: "default" });

    await plain.startRun(namespaceId, { workflowType: "checkout", input: { card: SECRET } });

    expect(await tablesHolding(SECRET)).toEqual(
      expect.arrayContaining(["run_events", "workflow_runs"]),
    );
  });

  it("keeps a run started under the old key readable after the key is rotated", async () => {
    const before = createEncryptionCodec({ keys: [keyOne], activeKeyId: "k1" });
    const first = boot(before);
    const started = await first.startRun(namespaceId, {
      workflowType: "checkout",
      input: { card: "old-key-card" },
    });
    const runId = started.run.runId;
    await until(async () => (await eventCount(runId, "step_completed")) === 1);
    await engine?.stop();

    const rotated = createEncryptionCodec({ keys: [keyOne, keyTwo], activeKeyId: "k2" });
    const second = boot(rotated);
    await second.signalRun(namespaceId, runId, "approve", { by: "new-key-approver" });
    await until(async () => (await status(runId)) !== "RUNNING");

    expect(await status(runId)).toBe("COMPLETED");
    expect(rotated.decode(await storedResult(runId))).toEqual({
      receipt: "old-key-card charged",
      approvedBy: "new-key-approver",
      child: "new-key-approver child charged",
    });
    const keys = await pool.query<{ key_id: string; event_type: string }>(
      `select payload #>> '{input,keyId}' as key_id, event_type from run_events
       where run_id = $1 and event_type = 'run_started'
       union all
       select payload #>> '{payload,keyId}', event_type from run_events
       where run_id = $1 and event_type = 'signal_received'`,
      [runId],
    );
    expect(keys.rows).toEqual([
      { key_id: "k1", event_type: "run_started" },
      { key_id: "k2", event_type: "signal_received" },
    ]);
  });
});
