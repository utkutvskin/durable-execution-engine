import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../.github/workflows/chaos-nightly.yml", import.meta.url),
  "utf8",
);
const suite = readFileSync(
  new URL("../../packages/worker/src/chaos/chaos-suite.integration.test.ts", import.meta.url),
  "utf8",
);

describe(".github/workflows/chaos-nightly.yml", () => {
  it("runs on a nightly schedule and can be started by hand", () => {
    expect(source).toMatch(/schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/);
    expect(source).toContain("workflow_dispatch:");
  });

  it("runs the chaos suite against a real postgres", () => {
    expect(source).toContain("image: postgres:16");
    expect(source).toContain("chaos-suite.integration.test.ts");
  });

  it("asks for more repetitions than the default and writes the report to the job summary", () => {
    const repetitions = Number(/DEE_CHAOS_REPETITIONS:\s*(\d+)/.exec(source)?.[1]);
    expect(repetitions).toBeGreaterThan(10);
    expect(source).toContain("DEE_CHAOS_REPORT:");
    expect(source).toContain("GITHUB_STEP_SUMMARY");
  });

  it("is a variable the suite reads, with ten repetitions by default", () => {
    expect(suite).toContain('process.env["DEE_CHAOS_REPETITIONS"] ?? 10');
  });

  it("uses the same current action majors as the main workflow", () => {
    expect(source).not.toMatch(/actions\/checkout@v[1-6]\b/);
    expect(source).not.toMatch(/actions\/setup-node@v[1-6]\b/);
  });
});
