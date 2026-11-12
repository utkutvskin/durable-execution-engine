import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentEventReader,
  KNOWN_EVENT_TYPES,
  readVersionedEvent,
  type EventReader,
} from "../packages/core/src/event-store/event-version.ts";
import {
  runStartedEventSchema,
  stepAttemptFailedEventSchema,
  stepScheduledEventSchema,
  timerStartedEventSchema,
  workflowEventSchema,
  type WorkflowEvent,
} from "../packages/core/src/event-store/events.ts";
import { replayHistories } from "../packages/core/src/replay/replay-histories.ts";
import { workflows } from "./fixtures/history-gate/workflows.ts";

const gateDirectory = path.join(import.meta.dirname, "fixtures", "history-gate", "histories");
const legacyDirectory = path.join(import.meta.dirname, "fixtures", "histories");

function jsonFiles(directory: string): readonly { file: string; content: unknown }[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      content: JSON.parse(readFileSync(path.join(directory, file), "utf8")) as unknown,
    }));
}

const gateFixtures = jsonFiles(gateDirectory);
const legacyFixtures = jsonFiles(legacyDirectory);

interface GateResult {
  readonly failures: readonly string[];
  readonly coveredTypes: ReadonlySet<string>;
}

/**
 * The history gate: every exported fixture history must be read by
 * `reader` and replay against the gate workflows to the outcome it
 * recorded, and every event of the older raw fixtures must still be read.
 */
async function runGate(reader: EventReader = currentEventReader): Promise<GateResult> {
  const failures: string[] = [];
  const report = await replayHistories(
    workflows,
    gateFixtures.map(({ file, content }) => ({ source: file, history: content })),
    { reader },
  );
  for (const result of report.results) {
    if (!result.passed) {
      failures.push(
        `${result.source}: ${result.problem?.kind ?? "failed"}: ${result.problem?.message ?? ""}`,
      );
    }
  }
  for (const { file, content } of legacyFixtures) {
    const history = (content as { history: readonly unknown[] }).history;
    history.forEach((raw, index) => {
      try {
        readVersionedEvent(raw, 1, reader);
      } catch (error) {
        failures.push(
          `${file}: event ${String(index + 1)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
  const coveredTypes = new Set(
    gateFixtures.flatMap(({ content }) =>
      (content as { events: { event: { type: string } }[] }).events.map(
        (entry) => entry.event.type,
      ),
    ),
  );
  return { failures, coveredTypes };
}

interface Parser {
  parse(raw: unknown): unknown;
}

function readerWith(changes: Readonly<Record<string, Parser | null>>): EventReader {
  const parsers = new Map<string, Parser>(
    workflowEventSchema.options.map((option) => [option.shape.type.value, option]),
  );
  for (const [type, parser] of Object.entries(changes)) {
    if (parser === null) {
      parsers.delete(type);
    } else {
      parsers.set(type, parser);
    }
  }
  return {
    knownTypes: [...parsers.keys()],
    parse: (raw) => {
      const type = (raw as { type?: unknown }).type;
      const parser = typeof type === "string" ? parsers.get(type) : undefined;
      if (parser === undefined) {
        throw new Error(`unknown event type ${String(type)}`);
      }
      return parser.parse(raw) as WorkflowEvent;
    },
  };
}

const requiredString = runStartedEventSchema.shape.workflowType;

describe("history fixture gate", () => {
  it("holds exported histories of real runs and the older raw fixtures", () => {
    expect(gateFixtures.length).toBeGreaterThanOrEqual(9);
    expect(legacyFixtures.length).toBeGreaterThanOrEqual(9);
  });

  it("replays every recorded history against today's code and event schema", async () => {
    const gate = await runGate();
    expect(gate.failures).toEqual([]);
  });

  it("covers every event type, so a new type needs a recorded fixture", async () => {
    const gate = await runGate();
    expect([...gate.coveredTypes].sort()).toEqual([...KNOWN_EVENT_TYPES].sort());
  });

  it("fails when an event gains a required field old histories do not have", async () => {
    const gate = await runGate(
      readerWith({ step_scheduled: stepScheduledEventSchema.extend({ queue: requiredString }) }),
    );
    expect(gate.failures.length).toBeGreaterThan(0);
    expect(gate.failures).toContainEqual(
      expect.stringMatching(/^gate-order-1\.json: invalid_history: .*event 2: step_scheduled/),
    );
    expect(gate.failures).toContainEqual(
      expect.stringMatching(/^ship-order-completed\.json: event 2: /),
    );
  });

  it("fails when a field is renamed", async () => {
    const gate = await runGate(
      readerWith({
        timer_started: timerStartedEventSchema
          .omit({ fireAt: true })
          .extend({ dueAt: requiredString }),
      }),
    );
    expect(gate.failures).toContainEqual(
      expect.stringMatching(/^gate-order-1\.json: invalid_history: .*event 4: timer_started/),
    );
  });

  it("fails when a field changes its type", async () => {
    const gate = await runGate(
      readerWith({
        step_attempt_failed: stepAttemptFailedEventSchema.extend({ attempt: requiredString }),
      }),
    );
    expect(gate.failures).toContainEqual(
      expect.stringMatching(
        /^gate-failures-1\.json: invalid_history: .*event 5: step_attempt_failed/,
      ),
    );
  });

  it("fails when an event type is removed", async () => {
    const gate = await runGate(readerWith({ signal_received: null }));
    expect(gate.failures).toContainEqual(
      expect.stringMatching(/^gate-order-1\.json: invalid_history: .*event 8: /),
    );
  });

  it("passes a compatible change: a new optional field", async () => {
    const gate = await runGate(
      readerWith({
        step_scheduled: stepScheduledEventSchema.extend({ queue: requiredString.optional() }),
      }),
    );
    expect(gate.failures).toEqual([]);
  });
});
