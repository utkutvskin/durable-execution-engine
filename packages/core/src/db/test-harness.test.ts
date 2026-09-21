import pg from "pg";
import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./env.js";
import { createIsolatedDatabase } from "./test-harness.js";

const { Pool } = pg;

describe("createIsolatedDatabase", () => {
  it("gives every call its own uniquely named schema", async () => {
    const first = await createIsolatedDatabase();
    const second = await createIsolatedDatabase();
    try {
      expect(first.schema).not.toBe(second.schema);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("keeps two isolated databases from seeing each other's rows, as two concurrent test files would", async () => {
    const fileA = await createIsolatedDatabase();
    const fileB = await createIsolatedDatabase();
    try {
      await fileA.pool.query("insert into namespaces (name) values ('from-file-a')");
      await fileB.pool.query("insert into namespaces (name) values ('from-file-b')");

      const rowsSeenByA = await fileA.pool.query<{ name: string }>("select name from namespaces");
      const rowsSeenByB = await fileB.pool.query<{ name: string }>("select name from namespaces");

      expect(rowsSeenByA.rows.map((row) => row.name)).toEqual(["from-file-a"]);
      expect(rowsSeenByB.rows.map((row) => row.name)).toEqual(["from-file-b"]);
    } finally {
      await fileA.close();
      await fileB.close();
    }
  });

  it("drops the schema on close, so its tables are no longer reachable", async () => {
    const database = await createIsolatedDatabase();
    const { schema } = database;
    await database.close();

    const adminPool = new Pool({ connectionString: resolveDatabaseUrl(process.env) });
    try {
      const result = await adminPool.query<{ schema_name: string }>(
        "select schema_name from information_schema.schemata where schema_name = $1",
        [schema],
      );
      expect(result.rows).toEqual([]);
    } finally {
      await adminPool.end();
    }
  });
});
