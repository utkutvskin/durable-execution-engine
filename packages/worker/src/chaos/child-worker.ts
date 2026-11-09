import { createPool, createPostgresEventStore, createTaskQueue } from "@dee/core";
import { writeSync } from "node:fs";
import { createEngineFlow, type EngineFlowHooks } from "./engine-kit.ts";
import { startEngine } from "../engine/runtime.ts";
import { createWorkerIdentity } from "../identity.ts";
import { createWorker } from "../worker.ts";
import { CRASH_POINTS, createFlowHandler, type CrashPoint } from "./flow.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseCrashPoint(value: string | undefined): CrashPoint | undefined {
  return CRASH_POINTS.find((point) => point === value);
}

const crashPoint = parseCrashPoint(process.env["DEE_CHAOS_CRASH_POINT"]);
const pool = createPool(process.env, { schema: requireEnv("DEE_CHAOS_SCHEMA"), max: 4 });
const identity = createWorkerIdentity({ version: process.env["DEE_CHAOS_VERSION"] ?? "0.0.0" });

function freeze(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function announce(point: string): void {
  writeSync(1, `checkpoint ${point} engine\n`);
}

if (process.env["DEE_CHAOS_RUNTIME"] === "engine") {
  const hooks: EngineFlowHooks = {
    onCheckpoint: async () => {
      announce("before-record");
      if (crashPoint === "before-record") {
        await new Promise<void>(() => undefined);
      }
    },
  };
  const flow = createEngineFlow(hooks);
  startEngine({
    onDecision: (decision) => {
      const point = decision.outcome === "completed" ? "after-finish" : "after-record";
      announce(point);
      if (point === crashPoint) {
        freeze();
      }
    },
    pool,
    queueName: requireEnv("DEE_CHAOS_QUEUE"),
    workflows: flow.workflows,
    steps: flow.steps,
    concurrency: 1,
    pollIntervalMs: 50,
    visibilityTimeoutMs: 30_000,
    poisonThreshold: 50,
    stickyTimeoutMs: 500,
    buildId: process.env["DEE_CHAOS_VERSION"] ?? "0.0.0",
  });
  writeSync(1, `ready ${identity.id}\n`);
} else {
  startFlowWorker();
}

function startFlowWorker(): void {
  const worker = createWorker({
    queue: createTaskQueue(pool),
    queueName: requireEnv("DEE_CHAOS_QUEUE"),
    concurrency: 1,
    pollIntervalMs: 50,
    maxPollIntervalMs: 200,
    visibilityTimeoutMs: 30_000,
    identity,
    handler: createFlowHandler({
      pool,
      store: createPostgresEventStore(pool),
      onCheckpoint: async (point, task) => {
        process.stdout.write(`checkpoint ${point} ${task.id}\n`);
        if (point === crashPoint) {
          await new Promise<void>(() => undefined);
        }
      },
    }),
  });

  process.stdout.write(`ready ${identity.id}\n`);
  worker.start();
}
