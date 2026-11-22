import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "@dee/core";
import { createIsolatedDatabase } from "../../../core/src/db/test-harness.ts";
import { measureStartLatency } from "./wakeup-latency.ts";

const samples = Number(process.env["BENCH_WAKEUP_SAMPLES"] ?? "50");
const idleMs = Number(process.env["BENCH_WAKEUP_IDLE_MS"] ?? "1500");
const database = await createIsolatedDatabase();
const producerPool = createPool(process.env, { schema: database.schema, notifyWakeups: true });
const enginePool = createPool(process.env, { schema: database.schema, notifyWakeups: true });
try {
  const namespace = await database.pool.query<{ id: string }>(
    "insert into namespaces (name) values ('default') returning id",
  );
  const namespaceId = namespace.rows[0]?.id ?? "";
  process.stdout.write("| Wake-ups | Samples | p50 (ms) | p95 (ms) | Max (ms) |\n");
  process.stdout.write("| --- | ---: | ---: | ---: | ---: |\n");
  for (const wakeups of [false, true]) {
    const summary = await measureStartLatency({
      enginePool,
      producerPool,
      namespaceId,
      queueName: wakeups ? "latency-notify" : "latency-poll",
      wakeups,
      samples,
      idle: () => delay(idleMs),
    });
    process.stdout.write(
      `| ${wakeups ? "on" : "off"} | ${String(summary.count)} | ${summary.p50Ms.toFixed(1)} | ${summary.p95Ms.toFixed(1)} | ${summary.maxMs.toFixed(1)} |\n`,
    );
  }
} finally {
  await producerPool.end();
  await enginePool.end();
  await database.close();
}
