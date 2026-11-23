import { setTimeout as delay } from "node:timers/promises";
import { createIsolatedDatabase } from "../../../core/src/db/test-harness.ts";
import { measureTableGrowth } from "./table-growth.ts";

const minutes = Number(process.env["BENCH_GROWTH_MINUTES"] ?? "30");
const sampleSeconds = Number(process.env["BENCH_GROWTH_SAMPLE_SECONDS"] ?? "60");
const retentionOn = (process.env["BENCH_GROWTH_RETENTION"] ?? "on") !== "off";
const database = await createIsolatedDatabase();
try {
  const namespace = await database.pool.query<{ id: string }>(
    "insert into namespaces (name) values ('default') returning id",
  );
  const namespaceId = namespace.rows[0]?.id ?? "";
  process.stdout.write(
    `retention ${retentionOn ? "on" : "off"}, ${String(minutes)} minutes, a reading every ${String(sampleSeconds)} s\n`,
  );
  process.stdout.write(
    "| Minute | Runs completed | `tasks` rows | `tasks` size (MB) | `task_history` rows |\n",
  );
  process.stdout.write("| ---: | ---: | ---: | ---: | ---: |\n");
  await measureTableGrowth({
    pool: database.pool,
    namespaceId,
    queueName: "growth",
    inFlight: 32,
    retention: retentionOn ? { finishedTaskGraceMs: 5_000, closedRunRetentionMs: 60_000 } : false,
    next: async () => {
      await delay(sampleSeconds * 1000);
    },
    stopWhen: (sample) => sample.elapsedMs >= minutes * 60_000,
    sample: (sample) => {
      process.stdout.write(
        `| ${(sample.elapsedMs / 60_000).toFixed(0)} | ${String(sample.runsCompleted)} | ${String(sample.taskRows)} | ${(sample.taskBytes / 1_048_576).toFixed(2)} | ${String(sample.historyRows)} |\n`,
      );
    },
  });
} finally {
  await database.close();
}
