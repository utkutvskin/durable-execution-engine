import { describe, expect, it } from "vitest";
import type { CliIo } from "../io.ts";
import { openReadPool } from "./process.ts";
import { parseCommand } from "./shared.ts";

const OPTIONS = { "database-read-url": { type: "string" } } as const;

function io(env: Record<string, string | undefined>): CliIo {
  return { stdout: () => undefined, stderr: () => undefined, env, cwd: "." };
}

describe("openReadPool", () => {
  it("opens no replica pool without the flag or DATABASE_READ_URL", () => {
    expect(openReadPool(parseCommand([], OPTIONS), io({}))).toBeUndefined();
    expect(openReadPool(parseCommand([], OPTIONS), io({ DATABASE_READ_URL: "" }))).toBeUndefined();
  });

  it("prefers --database-read-url over DATABASE_READ_URL", async () => {
    const pool = openReadPool(
      parseCommand(["--database-read-url", "postgres://flag@replica-a:5432/dee"], OPTIONS),
      io({ DATABASE_READ_URL: "postgres://env@replica-b:5432/dee" }),
      { poolSize: 3 },
    );
    expect(pool?.options.connectionString).toBe("postgres://flag@replica-a:5432/dee");
    expect(pool?.options.max).toBe(3);
    await pool?.end();

    const fromEnv = openReadPool(
      parseCommand([], OPTIONS),
      io({ DATABASE_READ_URL: "postgres://env@replica-b:5432/dee" }),
    );
    expect(fromEnv?.options.connectionString).toBe("postgres://env@replica-b:5432/dee");
    await fromEnv?.end();
  });
});
