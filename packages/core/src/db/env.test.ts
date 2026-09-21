import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./env.js";

describe("resolveDatabaseUrl", () => {
  it("returns DATABASE_URL verbatim when it is set", () => {
    const url = resolveDatabaseUrl({
      DATABASE_URL: "postgres://someone:secret@db.internal:6543/prod",
    });
    expect(url).toBe("postgres://someone:secret@db.internal:6543/prod");
  });

  it("builds a connection string from the POSTGRES_* variables when DATABASE_URL is unset", () => {
    const url = resolveDatabaseUrl({
      POSTGRES_USER: "alice",
      POSTGRES_PASSWORD: "hunter2",
      POSTGRES_DB: "workflows",
      POSTGRES_PORT: "5433",
    });
    expect(url).toBe("postgres://alice:hunter2@localhost:5433/workflows");
  });

  it("falls back to the docker-compose defaults when nothing is set", () => {
    const url = resolveDatabaseUrl({});
    expect(url).toBe("postgres://dee:dee@localhost:5432/dee");
  });
});
