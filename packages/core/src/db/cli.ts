import pg from "pg";
import { resolveDatabaseUrl } from "./env.js";
import { migrateDown, migrateUp } from "./migrator.js";

const { Pool } = pg;

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down") {
    throw new Error(`usage: migrate <up|down>, received "${direction ?? ""}"`);
  }

  const pool = new Pool({ connectionString: resolveDatabaseUrl(process.env) });
  try {
    const applied = direction === "up" ? await migrateUp(pool) : await migrateDown(pool);
    console.log(
      applied.length === 0 ? `${direction}: nothing to do` : `${direction}: ${applied.join(", ")}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
