import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ciSource = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

describe(".github/workflows/ci.yml", () => {
  it("triggers on push and on pull request", () => {
    expect(ciSource).toMatch(/on:\s*\n\s*push:/);
    expect(ciSource).toMatch(/pull_request:/);
  });

  it("runs on node 22, matching the fixed stack", () => {
    expect(ciSource).toMatch(/node-version:\s*22\b/);
  });

  it("runs the same verify script a developer runs locally", () => {
    expect(ciSource).toMatch(/run:\s*pnpm run verify\s*$/m);
  });
});
