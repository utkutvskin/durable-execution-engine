import { createPool } from "@dee/core";
import { createIsolatedDatabase } from "../../../core/src/db/test-harness.ts";
import { measureVisibilityQueries, seedVisibilityRuns } from "./visibility-queries.ts";

const runs = Number(process.env["BENCH_VISIBILITY_RUNS"] ?? "100000");
const rounds = Number(process.env["BENCH_VISIBILITY_ROUNDS"] ?? "20");
const database = await createIsolatedDatabase();
const pool = createPool(process.env, { schema: database.schema, max: 4 });
try {
  const namespaceId = await seedVisibilityRuns(pool, runs);
  const measured = await measureVisibilityQueries(pool, namespaceId, rounds);
  process.stdout.write(
    "| Query | Rows | Execution (ms) | Median wall (ms) | Slowest wall (ms) | Plan nodes |\n",
  );
  process.stdout.write("| --- | ---: | ---: | ---: | ---: | --- |\n");
  for (const { query, plan, medianMs, maxMs } of measured) {
    process.stdout.write(
      `| \`${query}\` | ${String(plan.rowsReturned)} | ${plan.executionMs.toFixed(2)} | ${medianMs.toFixed(2)} | ${maxMs.toFixed(2)} | ${[...new Set(plan.nodeTypes)].join(", ")} |\n`,
    );
  }
  for (const { query, text } of measured) {
    process.stdout.write(`\n${query}\n${text}\n`);
  }
} finally {
  await pool.end();
  await database.close();
}
