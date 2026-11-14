import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRunService } from "../../../packages/api/src/index.ts";
import { createIsolatedDatabase } from "../../../packages/core/src/db/test-harness.ts";
import { createEventService } from "../../../packages/core/src/events/external-events.ts";
import { createPostgresEventStore } from "../../../packages/core/src/event-store/event-store.ts";
import { createHistoryExport } from "../../../packages/core/src/replay/history-export.ts";
import { createRunInteractions } from "../../../packages/core/src/signals/signal-service.ts";
import { systemClock, systemRandomSource } from "../../../packages/core/src/workflow/sources.ts";
import {
  createWorkflowRegistry,
  type WorkflowDefinition,
} from "../../../packages/core/src/workflow/workflow-registry.ts";
import { startEngine } from "../../../packages/worker/src/engine/runtime.ts";
import { steps, workflows } from "./workflows.ts";

const directory = path.join(import.meta.dirname, "histories");

const CLOSING_TYPES = [
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_terminated",
  "run_timed_out",
  "run_continued_as_new",
];

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const database = await createIsolatedDatabase();
  const { pool } = database;
  const namespace = await pool.query<{ id: string }>(
    "insert into namespaces (name) values ('default') returning id",
  );
  const namespaceId = namespace.rows[0]?.id ?? "";
  const service = createRunService(pool, { queueName: "default" });
  const registry = createWorkflowRegistry();
  for (const workflow of workflows as readonly WorkflowDefinition<never>[]) {
    registry.register(workflow);
  }
  const interactions = createRunInteractions(pool, {
    workflows: registry,
    clock: systemClock,
    random: systemRandomSource,
  });
  const engine = startEngine({
    pool,
    workflows,
    steps,
    pollIntervalMs: 5,
    loopIntervalMs: 20,
    concurrency: 4,
    shutdownTimeoutMs: 2_000,
    onError: (error) => {
      process.stderr.write(`engine error: ${String(error)}\n`);
    },
  });

  async function start(
    workflowType: string,
    input: unknown,
    runTimeoutMs?: number,
  ): Promise<string> {
    const started = await service.startRun(namespaceId, {
      workflowType,
      input,
      ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
    });
    return started.run.runId;
  }

  async function waitFor(runId: string, eventType: string): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const found = await pool.query(
        "select 1 from run_events where run_id = $1 and payload ->> 'type' = $2",
        [runId, eventType],
      );
      if (found.rowCount !== 0) {
        return;
      }
      await pause(10);
    }
    throw new Error(`run ${runId} never recorded ${eventType}`);
  }

  try {
    const order = await start("gate-order", { orderId: "order-1" });
    await start("gate-failures", { orderId: "order-2" });
    const cancel = await start("gate-cancel", { orderId: "order-3" });
    await start("gate-loop", { round: 0 });
    await start("gate-waiting", {}, 300);
    const terminated = await start("gate-waiting", {});
    const updated = await start("gate-update", {});
    await createEventService(pool).sendEvent(namespaceId, {
      eventName: "gate.paid",
      key: "order-9",
      payload: { amount: 12 },
    });
    await start("gate-event", { orderId: "order-9" });

    await waitFor(order, "time_recorded");
    await service.signalRun(namespaceId, order, "approve", { by: "ada" });
    await waitFor(cancel, "run_started");
    await pause(200);
    await service.cancelRun(namespaceId, cancel, "customer changed their mind");
    await service.terminateRun(namespaceId, terminated, "operator stopped it");
    await interactions.updateRun(updated, "gate.note", "first", { waitMs: 10_000 });
    await interactions.updateRun(updated, "gate.refuse", null, { waitMs: 10_000 });
    await service.signalRun(namespaceId, updated, "close", null);

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const open = await pool.query(
        `select 1 from workflow_runs w
         where w.status = 'RUNNING'
            or not exists (
              select 1 from run_events e
              where e.run_id = w.id
                and e.payload ->> 'type' in (${CLOSING_TYPES.map((type) => `'${type}'`).join(", ")})
            )`,
      );
      if (open.rowCount === 0) {
        break;
      }
      await pause(20);
    }

    const store = createPostgresEventStore(pool);
    const runs = await pool.query<{ id: string; workflow_type: string; status: string }>(
      "select id, workflow_type, status from workflow_runs order by created_at, id",
    );
    await mkdir(directory, { recursive: true });
    for (const file of await readdir(directory)) {
      await rm(path.join(directory, file));
    }
    const counts = new Map<string, number>();
    for (const run of runs.rows) {
      const index = (counts.get(run.workflow_type) ?? 0) + 1;
      counts.set(run.workflow_type, index);
      const events = await store.read(run.id);
      const exported = createHistoryExport({ runId: run.id, events });
      const file = path.join(directory, `${run.workflow_type}-${String(index)}.json`);
      await writeFile(file, `${JSON.stringify(exported, null, 2)}\n`, "utf8");
      process.stdout.write(
        `${path.basename(file)} ${run.status}: ${events.map((stored) => stored.event.type).join(", ")}\n`,
      );
    }
  } finally {
    await engine.stop();
    await database.close();
  }
}

await main();
