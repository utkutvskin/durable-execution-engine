import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../packages/core/src/event-store/events.js";
import type { WorkflowCommand } from "../packages/core/src/workflow/commands.js";
import { runDecisionLoop } from "../packages/core/src/workflow/decision-loop.js";
import type { WorkflowHandler } from "../packages/core/src/workflow/context.js";
import type { ClockSource, RandomSource } from "../packages/core/src/workflow/sources.js";
import { shipOrderWorkflow } from "./fixtures/workflows/ship-order.js";

interface RecordedHistoryFixture {
  readonly workflowType: string;
  readonly input: unknown;
  readonly history: readonly WorkflowEvent[];
  readonly expected:
    | { readonly outcome: "suspended"; readonly commands: readonly WorkflowCommand[] }
    | { readonly outcome: "completed"; readonly result: unknown; readonly commands: readonly WorkflowCommand[] }
    | {
        readonly outcome: "failed";
        readonly error: { readonly name: string; readonly message: string };
        readonly commands: readonly WorkflowCommand[];
      };
}

const workflowsByType: Record<string, WorkflowHandler> = {
  "ship-order": shipOrderWorkflow().handler as WorkflowHandler,
};

function fixedSources(): { readonly clock: ClockSource; readonly random: RandomSource } {
  return {
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    random: { random: () => 0.5, uuid: () => "fixed-uuid" },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "histories");

function loadFixtures(): readonly { readonly file: string; readonly fixture: RecordedHistoryFixture }[] {
  return readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8")) as RecordedHistoryFixture,
    }));
}

/**
 * Replays every recorded history fixture under `test/fixtures/histories`
 * against today's workflow code and checks it against the outcome and
 * command sequence recorded alongside it. Each fixture is what a real
 * history read out of the event store would look like: plain, serialized
 * `WorkflowEvent[]` JSON, not a value built by hand inside a test file. A
 * fixture failing here means either a genuine regression or, if the
 * workflow was changed on purpose, that the fixture (and, ideally, a
 * corresponding `docs/DECISIONS.md` entry) needs to be regenerated for the
 * new behavior.
 */
describe("recorded history replay harness", () => {
  for (const { file, fixture } of loadFixtures()) {
    it(`replays "${file}" to its recorded outcome`, async () => {
      const handler = workflowsByType[fixture.workflowType];
      if (handler === undefined) {
        throw new Error(`no workflow registered for fixture workflow type "${fixture.workflowType}"`);
      }

      const outcome = await runDecisionLoop(handler, fixture.input, fixture.history, fixedSources());

      if (fixture.expected.outcome === "failed") {
        expect(outcome.outcome).toBe("failed");
        if (outcome.outcome === "failed") {
          expect(outcome.error.name).toBe(fixture.expected.error.name);
          expect(outcome.error.message).toBe(fixture.expected.error.message);
        }
        expect(outcome.commands).toEqual(fixture.expected.commands);
        return;
      }

      expect(outcome).toEqual(fixture.expected);
    });
  }

  it("found at least one fixture to run", () => {
    expect(loadFixtures().length).toBeGreaterThan(0);
  });
});
