import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHealthChecks,
  createTaskQueue,
  defineStep,
  defineWorkflow,
  ENGINE_METRIC_NAMES,
  type Pool,
} from "@dee/core";
import { parsePrometheusText } from "../../../core/src/observability/prometheus-text.js";
import { createRunService, type RunService } from "../../../api/src/index.js";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { startOpsServer, type OpsServer } from "../ops-server.js";
import { waitFor } from "../test-support.js";
import { startEngine, type Engine } from "./runtime.js";

describe("engine production wiring against postgres", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let namespaceId: string;
  let service: RunService;
  const engines: Engine[] = [];
  const servers: OpsServer[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
    service = createRunService(pool, { queueName: "default" });
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
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  });

  const echo = defineStep<{ value: number }, number>("echo", { handler: ({ value }) => value });
  const gate = defineWorkflow("gate", async (ctx) => {
    await ctx.step<number>("echo", { value: 1 });
    await ctx.waitForSignal("go");
    return ctx.step<number>("echo", { value: 2 });
  });
  const quick = defineWorkflow("quick", (ctx) => ctx.step<number>("echo", { value: 3 }));

  function boot(options: Partial<Parameters<typeof startEngine>[0]> = {}): Engine {
    const engine = startEngine({
      pool,
      workflows: [gate, quick],
      steps: [echo],
      pollIntervalMs: 10,
      loopIntervalMs: 50,
      ...options,
    });
    engines.push(engine);
    return engine;
  }

  async function statusOf(runId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.status ?? "missing";
  }

  async function stickyWorkers(runId: string): Promise<string[]> {
    const result = await pool.query<{ worker_id: string }>(
      "select worker_id from run_stickiness where run_id = $1",
      [runId],
    );
    return result.rows.map((row) => row.worker_id);
  }

  it("fills dee_task_latency_seconds from the tasks the worker settles", async () => {
    const engine = boot();
    const started = await service.startRun(namespaceId, { workflowType: "quick" });
    await waitFor(async () => (await statusOf(started.run.runId)) === "COMPLETED");
    await waitFor(async () => {
      const parsed = parsePrometheusText(await engine.metrics.render());
      return parsed.samples.some((sample) => sample.name === "dee_task_latency_seconds_count");
    });
    const parsed = parsePrometheusText(await engine.metrics.render());
    const count = parsed.samples
      .filter((sample) => sample.name === "dee_task_latency_seconds_count")
      .reduce((sum, sample) => sum + sample.value, 0);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("fills dee_leases_reclaimed_total from the janitor of the engine", async () => {
    const engine = boot();
    const started = await service.startRun(namespaceId, { workflowType: "quick" });
    await waitFor(async () => (await statusOf(started.run.runId)) === "COMPLETED");
    const queue = createTaskQueue(pool);
    await queue.enqueue({
      namespaceId,
      runId: started.run.runId,
      queueName: "orphans",
      taskType: "WORKFLOW_TASK",
    });
    const leased = await queue.dequeue({
      queueName: "orphans",
      visibilityTimeoutMs: 1,
      workerId: "crashed-worker",
    });
    expect(leased).toHaveLength(1);
    await waitFor(() => engine.recovery.snapshot().leasesReclaimed >= 1);
    const parsed = parsePrometheusText(await engine.metrics.render());
    const reclaimed = parsed.samples.find((sample) => sample.name === "dee_leases_reclaimed_total");
    expect(reclaimed?.value).toBeGreaterThanOrEqual(1);
  });

  it("renders a series for seven of the eight engine metrics on an idle queue", async () => {
    const engine = boot();
    const parsed = parsePrometheusText(await engine.metrics.render());
    const observedOnly = ["dee_task_latency_seconds"];
    for (const name of ENGINE_METRIC_NAMES.filter((entry) => !observedOnly.includes(entry))) {
      expect(
        parsed.samples.some((sample) => sample.name === name),
        name,
      ).toBe(true);
    }
    expect(
      parsed.samples.find((s) => s.name === "dee_queue_depth" && s.labels["queue"] === "default"),
    ).toBeDefined();
  });

  it("claims an open run for the deciding worker and releases the claim when the run closes", async () => {
    const engine = boot();
    const started = await service.startRun(namespaceId, { workflowType: "gate" });
    const runId = started.run.runId;
    await waitFor(async () => (await stickyWorkers(runId)).length === 1);
    expect(await stickyWorkers(runId)).toEqual([engine.workerId]);
    await service.signalRun(namespaceId, runId, "go", {});
    await waitFor(async () => (await statusOf(runId)) === "COMPLETED");
    await waitFor(async () => (await stickyWorkers(runId)).length === 0);
  });

  it("does not claim runs when sticky routing is off", async () => {
    boot({ stickyRouting: false });
    const started = await service.startRun(namespaceId, { workflowType: "gate" });
    const runId = started.run.runId;
    await waitFor(async () => {
      const result = await pool.query<{ waiting_on: string | null }>(
        "select waiting_on from workflow_runs where id = $1",
        [runId],
      );
      return result.rows[0]?.waiting_on === "external";
    });
    expect(await stickyWorkers(runId)).toEqual([]);
  });

  it("drops the sticky claims of a worker when it stops", async () => {
    const engine = boot();
    const started = await service.startRun(namespaceId, { workflowType: "gate" });
    const runId = started.run.runId;
    await waitFor(async () => (await stickyWorkers(runId)).length === 1);
    await engine.stop();
    expect(await stickyWorkers(runId)).toEqual([]);
  });

  it("compacts closed runs on the configured schedule", async () => {
    boot({ compaction: { intervalMs: 50, policy: { closedRunRetentionMs: 0, tailEvents: 0 } } });
    const started = await service.startRun(namespaceId, { workflowType: "quick" });
    const runId = started.run.runId;
    await waitFor(async () => (await statusOf(runId)) === "COMPLETED");
    await waitFor(async () => {
      const result = await pool.query("select 1 from run_snapshots where run_id = $1", [runId]);
      return result.rowCount === 1;
    });
  });

  it("serves health, readiness and metrics on the ops port and guards metrics with a token", async () => {
    const engine = boot();
    const server = await startOpsServer({
      health: createHealthChecks(pool),
      metrics: engine.metrics,
      port: 0,
      host: "127.0.0.1",
      metricsToken: "scrape-token",
    });
    servers.push(server);
    const base = `http://127.0.0.1:${String(server.port)}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true });
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const scrape = await fetch(`${base}/metrics`, {
      headers: { authorization: "Bearer scrape-token" },
    });
    expect(scrape.status).toBe(200);
    expect(await scrape.text()).toContain("dee_queue_depth");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
  });
});
