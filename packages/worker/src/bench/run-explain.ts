import { createPool } from "@dee/core";
import { createIsolatedDatabase } from "../../../core/src/db/test-harness.js";
import { explainHotQueries, seedHotTables } from "./hot-queries.js";

const runs = Number(process.env["BENCH_EXPLAIN_RUNS"] ?? "100000");
const database = await createIsolatedDatabase();
const pool = createPool(process.env, { schema: database.schema, max: 4 });
try {
  const seeded = await seedHotTables(pool, { runs });
  const plans = await explainHotQueries(pool, seeded);
  process.stdout.write("| Query | Execution (ms) | Rows | Sequential scans | Plan nodes |\n");
  process.stdout.write("| --- | ---: | ---: | --- | --- |\n");
  for (const plan of plans) {
    const scans = plan.sequentialScans.length === 0 ? "none" : plan.sequentialScans.join(", ");
    process.stdout.write(
      `| ${plan.name} | ${plan.executionMs.toFixed(2)} | ${String(plan.rowsReturned)} | ${scans} | ${[...new Set(plan.nodeTypes)].join(", ")} |\n`,
    );
  }
} finally {
  await pool.end();
  await database.close();
}
