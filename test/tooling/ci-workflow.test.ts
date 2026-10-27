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

  it("uses the current major version of every action", () => {
    expect(ciSource).not.toMatch(/actions\/checkout@v[1-6]\b/);
    expect(ciSource).not.toMatch(/actions\/setup-node@v[1-6]\b/);
    expect(ciSource).not.toMatch(/pnpm\/action-setup@v[1-5]\b/);
  });

  it("installs a browser for the explorer test before verify", () => {
    const install = ciSource.indexOf("playwright-core install");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(ciSource.indexOf("run: pnpm run verify"));
    expect(ciSource).toContain("PLAYWRIGHT_CHROMIUM_PATH=");
  });

  it("waits for /ready in the docker job and prints diagnostics when it never answers", () => {
    const dockerJob = ciSource.slice(ciSource.indexOf("  docker:"));
    expect(dockerJob).toMatch(/curl -fsS http:\/\/127\.0\.0\.1:8080\/ready/);
    expect(dockerJob).toContain("docker logs engine");
    expect(dockerJob).toContain("exit 1");
    expect(dockerJob).toContain("if: failure()");
  });
});
