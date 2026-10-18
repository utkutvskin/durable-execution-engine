import { describe, expect, it } from "vitest";
import { renderChaosReport } from "./report.js";
import { SCENARIOS, type RepetitionResult } from "./scenarios.js";

function result(scenario: RepetitionResult["scenario"], repetition: number): RepetitionResult {
  return {
    scenario,
    repetition,
    seed: 1000 + repetition,
    durationMs: 10 + repetition,
    runs: 4,
    tasks: 4,
    faults: 2,
    survivedErrors: 1,
    redeliveries: 5,
    violations: [],
  };
}

describe("chaos report", () => {
  const clean = SCENARIOS.flatMap((scenario) =>
    Array.from({ length: 3 }, (_, repetition) => result(scenario.name, repetition)),
  );

  it("states the totals and says no violation was found", () => {
    const text = renderChaosReport(SCENARIOS, clean);
    expect(text).toContain("18 repetitions across 6 scenarios, 0 invariant violations.");
    expect(text).toContain("## Violations\n\nNone.");
  });

  it("has one table row per scenario with its sums", () => {
    const text = renderChaosReport(SCENARIOS, clean);
    expect(text).toContain("| Worker kill | 3 | 12 | 6 | 15 | 3 | 0 | 12 ms |");
    expect(text).toContain("| Network latency | 3 | 12 | 6 | 15 | 3 | 0 | 12 ms |");
  });

  it("lists every violation with its scenario, seed and check", () => {
    const broken: RepetitionResult = {
      ...result("slow-disk", 4),
      violations: [{ check: "task-not-lost", runId: "run-1", detail: "task | gone" }],
    };
    const text = renderChaosReport(SCENARIOS, [...clean, broken]);
    expect(text).toContain("19 repetitions across 6 scenarios, 1 invariant violations.");
    expect(text).toContain("| slow-disk | 4 | 1004 | task-not-lost | run-1 | task \\| gone |");
  });

  it("describes every invariant and every scenario", () => {
    const text = renderChaosReport(SCENARIOS, clean);
    for (const name of [
      "run-terminal-or-advancing",
      "task-not-lost",
      "step-result-written-once",
      "projection-consistent",
      "timer-fired-once",
    ]) {
      expect(text).toContain(`\`${name}\``);
    }
    for (const scenario of SCENARIOS) {
      expect(text).toContain(`### ${scenario.title}`);
    }
  });
});
