import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderChaosReport } from "./report.js";
import { SCENARIOS, runRepetition, type RepetitionResult } from "./scenarios.js";
import { createChaosWorld, type ChaosWorld } from "./world.js";

const REPETITIONS = 10;
const SCENARIO_TIMEOUT_MS = 240_000;

describe("chaos suite", () => {
  const results: RepetitionResult[] = [];
  let world: ChaosWorld;

  beforeAll(async () => {
    world = await createChaosWorld();
  });

  afterAll(async () => {
    const reportPath = process.env["DEE_CHAOS_REPORT"];
    if (reportPath !== undefined && reportPath !== "") {
      await writeFile(reportPath, renderChaosReport(SCENARIOS, results));
    }
    await world.database.close();
  });

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    "%s: ten repetitions break no invariant",
    async (_name, scenario) => {
      const own: RepetitionResult[] = [];
      for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
        own.push(await runRepetition(scenario, world, repetition));
      }
      results.push(...own);
      const violations = own.flatMap((result) =>
        result.violations.map(
          (violation) =>
            `${scenario.name}#${String(result.repetition)} seed ${String(result.seed)} ${violation.check}: ${violation.detail}`,
        ),
      );
      expect(violations).toEqual([]);
      expect(own).toHaveLength(REPETITIONS);
      expect(own.every((result) => result.faults > 0)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
