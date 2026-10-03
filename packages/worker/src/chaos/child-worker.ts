import { createPool, createPostgresEventStore, createTaskQueue } from "@dee/core";
import { createWorkerIdentity } from "../identity.js";
import { createWorker } from "../worker.js";
import { CRASH_POINTS, createFlowHandler, type CrashPoint } from "./flow.js";

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
