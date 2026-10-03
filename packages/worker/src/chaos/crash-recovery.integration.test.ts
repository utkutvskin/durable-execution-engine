import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createJanitor,
  createPostgresEventStore,
  createRecoveryMetrics,
  createTaskQueue,
  type ClockSource,
  type Janitor,
  type EventStore,
} from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.js";
import { createWorkerIdentity } from "../identity.js";
import { createWorker } from "../worker.js";
import { waitFor } from "../test-support.js";
import { CRASH_POINTS, createFlowHandler, type CrashPoint } from "./flow.js";
import { spawnChaosChild, type ChaosChild } from "./process-harness.js";

const QUEUE = "default/steps";
const AFTER_EXPIRY: ClockSource = { now: () => new Date(Date.now() + 120_000) };
const SPAWN_TIMEOUT_MS = 60_000;

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

describe("crash recovery with SIGKILL", () => {
  let database: IsolatedSchema;
  let store: EventStore;
  let namespaceId: string;
  let janitor: Janitor;
  const metrics = createRecoveryMetrics();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    store = createPostgresEventStore(database.pool);
    janitor = createJanitor(database.pool, { clock: AFTER_EXPIRY, metrics });
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  async function startRun(value: number): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      "insert into workflow_runs (namespace_id, workflow_type) values ($1, 'double') returning id",
      [namespaceId],
    );
    const runId = run.rows[0]?.id ?? "";
    await store.append(runId, 0, [
      { type: "run_started", workflowType: "double", input: { value } },
      { type: "step_scheduled", stepId: "step-1", stepType: "double", input: { value } },
    ]);
    await createTaskQueue(database.pool).enqueue({
      namespaceId,
      runId,
      queueName: QUEUE,
      taskType: "STEP_TASK",
      payload: { stepId: "step-1", value },
    });
    return runId;
  }

  async function runStatus(runId: string): Promise<{ status: string; result: unknown }> {
    const row = await database.pool.query<{ status: string; result: unknown }>(
      "select status, result from workflow_runs where id = $1",
      [runId],
    );
    return row.rows[0] ?? { status: "MISSING", result: null };
  }

  async function eventTypes(runId: string): Promise<string[]> {
    const events = await store.read(runId);
    return events.map((stored) => stored.event.type);
  }

  async function startChild(runCount: number, crashPoint: CrashPoint): Promise<ChaosChild[]> {
    const children = Array.from({ length: runCount }, () =>
      spawnChaosChild({
        schema: database.schema,
        queueName: QUEUE,
        crashPoint,
        version: "1.0.0",
      }),
    );
    await Promise.all(children.map((child) => child.waitForLine("ready")));
    return children;
  }

  async function finishWithRecoveryWorker(expectedRuns: readonly string[]): Promise<void> {
    const worker = createWorker({
      queue: createTaskQueue(database.pool, { clock: AFTER_EXPIRY }),
      queueName: QUEUE,
      concurrency: 4,
      pollIntervalMs: 10,
      maxPollIntervalMs: 50,
      identity: createWorkerIdentity({ version: "2.0.0" }),
      handler: createFlowHandler({ pool: database.pool, store }),
    });
    worker.start();
    await waitFor(async () => {
      const statuses = await Promise.all(expectedRuns.map((runId) => runStatus(runId)));
      return statuses.every((entry) => entry.status === "COMPLETED");
    });
    await worker.stop();
  }

  it(
    "lets a second worker finish a step whose worker was killed with SIGKILL mid-step",
    async () => {
      const runId = await startRun(21);
      const [child] = await startChild(1, "before-record");
      const victim = defined(child);
      const checkpoint = await victim.waitForLine("checkpoint before-record");
      expect(checkpoint).toContain("checkpoint before-record");
      const lease = await database.pool.query<{
        state: string;
        leased_by: string;
        leased_by_version: string;
      }>("select state, leased_by, leased_by_version from tasks where run_id = $1", [runId]);
      expect(lease.rows[0]?.state).toBe("LEASED");
      expect(lease.rows[0]?.leased_by_version).toBe("1.0.0");

      const exit = await victim.kill("SIGKILL");
      expect(exit.signal).toBe("SIGKILL");
      expect(await eventTypes(runId)).toEqual(["run_started", "step_scheduled"]);

      const reclaimed = await janitor.reclaimOrphanedLeases();
      expect(reclaimed.map((task) => task.leasedBy)).toEqual([lease.rows[0]?.leased_by]);
      await finishWithRecoveryWorker([runId]);

      expect(await runStatus(runId)).toEqual({ status: "COMPLETED", result: 42 });
      expect(await eventTypes(runId)).toEqual([
        "run_started",
        "step_scheduled",
        "step_completed",
        "run_completed",
      ]);
      const task = await database.pool.query<{ state: string; attempts: number }>(
        "select state, attempts from tasks where run_id = $1",
        [runId],
      );
      expect(task.rows[0]).toEqual({ state: "COMPLETED", attempts: 2 });
    },
    SPAWN_TIMEOUT_MS,
  );

  it.each(CRASH_POINTS.filter((point) => point !== "before-record"))(
    "records the step and the run once when the worker is killed at %s",
    async (point) => {
      const runId = await startRun(5);
      const [child] = await startChild(1, point);
      const victim = defined(child);
      await victim.waitForLine(`checkpoint ${point}`);
      await victim.kill("SIGKILL");

      await janitor.reclaimOrphanedLeases();
      await finishWithRecoveryWorker([runId]);

      expect(await runStatus(runId)).toEqual({ status: "COMPLETED", result: 10 });
      expect(await eventTypes(runId)).toEqual([
        "run_started",
        "step_scheduled",
        "step_completed",
        "run_completed",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "brings 20 runs to a terminal state after 20 workers are killed at mixed points, losing none",
    async () => {
      const repetitions = 20;
      const runs = await Promise.all(
        Array.from({ length: repetitions }, (_, index) => startRun(index + 1)),
      );
      const victims: ChaosChild[] = [];
      const pointsUsed = new Set<CrashPoint>();
      for (let index = 0; index < repetitions; index += 1) {
        const point = defined(CRASH_POINTS[index % CRASH_POINTS.length]);
        pointsUsed.add(point);
        victims.push(...(await startChild(1, point)));
      }
      await waitFor(async () => {
        const leased = await database.pool.query<{ count: string }>(
          "select count(*) from tasks where state = 'LEASED' and leased_by is not null",
        );
        return Number(leased.rows[0]?.count) === repetitions;
      });
      await Promise.all(victims.map((victim) => victim.kill("SIGKILL")));

      const before = metrics.snapshot().leasesReclaimed;
      const report = await janitor.sweep({ graceMs: 60_000, queueName: QUEUE });
      expect(report.reclaimed).toHaveLength(repetitions);
      expect(metrics.snapshot().leasesReclaimed - before).toBe(repetitions);
      await finishWithRecoveryWorker(runs);

      const statuses = await Promise.all(runs.map((runId) => runStatus(runId)));
      expect(statuses.map((entry) => entry.status)).toEqual(Array(repetitions).fill("COMPLETED"));
      expect(statuses.map((entry) => entry.result)).toEqual(
        runs.map((_, index) => (index + 1) * 2),
      );
      const counts = await Promise.all(runs.map((runId) => eventTypes(runId)));
      counts.forEach((types) => {
        expect(types.filter((type) => type === "step_completed")).toHaveLength(1);
        expect(types.filter((type) => type === "run_completed")).toHaveLength(1);
      });
      const open = await database.pool.query<{ count: string }>(
        "select count(*) from tasks where state <> 'COMPLETED'",
      );
      expect(Number(open.rows[0]?.count)).toBe(0);
      expect(await janitor.findStalledRuns({ graceMs: 0 })).toEqual([]);
      expect(pointsUsed.size).toBe(CRASH_POINTS.length);
    },
    SPAWN_TIMEOUT_MS,
  );
});
