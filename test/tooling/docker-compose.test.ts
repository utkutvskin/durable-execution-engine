import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composeSource = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");

describe("docker-compose.yml", () => {
  it("runs postgres 16", () => {
    expect(composeSource).toMatch(/image:\s*postgres:16\b/);
  });

  it("exposes the port configured by POSTGRES_PORT, defaulting to 5432", () => {
    expect(composeSource).toMatch(/\$\{POSTGRES_PORT:-5432\}:5432/);
  });

  it("declares a healthcheck so dependents can wait for readiness instead of a fixed sleep", () => {
    expect(composeSource).toMatch(/healthcheck:/);
    expect(composeSource).toMatch(/pg_isready/);
  });
});
