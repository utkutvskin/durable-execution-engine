import { currentEventReader, type EventReader } from "../event-store/event-version.ts";
import type { WorkflowEvent } from "../event-store/events.ts";
import { recordedCommandOf } from "../workflow/command-matcher.ts";
import type { WorkflowHandler } from "../workflow/context.ts";
import { runDecisionLoop, type DecisionResult } from "../workflow/decision-loop.ts";
import { NonDeterminismError, VersionMismatchError } from "../workflow/errors.ts";
import { ForbiddenApiError, WorkflowActiveAfterQuiescenceError } from "../workflow/sandbox.ts";
import {
  InvalidHistoryExportError,
  parseHistoryExport,
  type ParsedHistory,
} from "./history-export.ts";

/**
 * A workflow `replayHistories` can replay: what `defineWorkflow` returns.
 */
export interface ReplayableWorkflow {
  readonly workflowType: string;
  readonly handler: WorkflowHandler<never>;
}

/**
 * One history to replay. `history` is a parsed export (the JSON of a file
 * `wf history export` wrote) and `source` names it in the report.
 */
export interface HistoryToReplay {
  readonly source: string;
  readonly history: unknown;
}

/**
 * Why a history did not replay:
 *
 * - `non_determinism`: the code issues other commands than the history
 *   recorded, or does not issue one it recorded;
 * - `version_mismatch`: the history holds a patch the code no longer asks about;
 * - `forbidden_api`: the code calls `Date.now`, `Math.random` or a timer
 *   directly, or keeps working after the decision went quiet;
 * - `outcome_mismatch`: the history closed the run in one way and the code
 *   closes it in another, or not at all;
 * - `unknown_workflow`: no workflow of the history's type was given;
 * - `invalid_history`: the file is not a history this build can read;
 * - `replay_error`: anything else the replay threw.
 */
export type ReplayProblemKind =
  | "non_determinism"
  | "version_mismatch"
  | "forbidden_api"
  | "outcome_mismatch"
  | "unknown_workflow"
  | "invalid_history"
  | "replay_error";

/**
 * What went wrong with one history, and the event it went wrong at when
 * one can be named.
 */
export interface ReplayProblem {
  readonly kind: ReplayProblemKind;
  readonly message: string;
  readonly sequenceNumber?: number;
  readonly eventType?: string;
}

/**
 * The outcome of replaying one history. `runId` and `workflowType` are
 * missing only when the file could not be read.
 */
export interface HistoryReplayResult {
  readonly source: string;
  readonly runId?: string;
  readonly workflowType?: string;
  readonly eventCount: number;
  readonly passed: boolean;
  readonly problem?: ReplayProblem;
}

/**
 * The outcome of `replayHistories`: one result per history, in the order
 * given, and how many passed and failed.
 */
export interface ReplayReport {
  readonly results: readonly HistoryReplayResult[];
  readonly passed: number;
  readonly failed: number;
}

/**
 * Options of `replayHistories`. `buildId` is reported by a version mismatch
 * as the replaying build; `reader` replaces this build's event schema.
 */
export interface ReplayHistoriesOptions {
  readonly buildId?: string;
  readonly reader?: EventReader;
}

type IndexedEvent = ParsedHistory["events"][number];

const CLOSING_OUTCOMES: Readonly<
  Partial<Record<WorkflowEvent["type"], DecisionResult["outcome"]>>
> = {
  run_completed: "completed",
  run_failed: "failed",
  run_cancelled: "cancelled",
  run_continued_as_new: "continued_as_new",
};

const CLOSING_COMMANDS = new Set(["complete_run", "fail_run", "cancel_run", "continue_as_new"]);

function at(entry: IndexedEvent | undefined): Pick<ReplayProblem, "sequenceNumber" | "eventType"> {
  return entry === undefined
    ? {}
    : { sequenceNumber: entry.sequenceNumber, eventType: entry.event.type };
}

function findCommandEvent(
  events: readonly IndexedEvent[],
  id: string | undefined,
): IndexedEvent | undefined {
  return id === undefined
    ? undefined
    : events.find((entry) => recordedCommandOf(entry.event)?.id === id);
}

function problemOf(error: unknown, events: readonly IndexedEvent[]): ReplayProblem {
  if (error instanceof NonDeterminismError) {
    const entry =
      findCommandEvent(events, error.recordedId) ??
      findCommandEvent(events, error.stepId) ??
      events.at(-1);
    return { kind: "non_determinism", message: error.message, ...at(entry) };
  }
  if (error instanceof VersionMismatchError) {
    const entry = events.find(
      (candidate) =>
        candidate.event.type === "patch_recorded" &&
        error.patchIds.includes(candidate.event.patchId),
    );
    return { kind: "version_mismatch", message: error.message, ...at(entry) };
  }
  if (error instanceof ForbiddenApiError || error instanceof WorkflowActiveAfterQuiescenceError) {
    return { kind: "forbidden_api", message: error.message };
  }
  return {
    kind: "replay_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function checkClosed(
  decision: DecisionResult,
  events: readonly IndexedEvent[],
): ReplayProblem | undefined {
  const last = events.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const expected = CLOSING_OUTCOMES[last.event.type];
  if (expected === undefined) {
    return undefined;
  }
  const extra = decision.commands.filter((command) => !CLOSING_COMMANDS.has(command.type));
  if (decision.outcome === expected && extra.length === 0) {
    return undefined;
  }
  const found =
    decision.outcome === "suspended"
      ? `stays open and would issue ${extra.map((command) => command.type).join(", ") || "nothing"}`
      : extra.length > 0
        ? `ends as ${decision.outcome} after issuing ${extra.map((command) => command.type).join(", ")}`
        : `ends as ${decision.outcome}`;
  return {
    kind: "outcome_mismatch",
    message: `the history closed the run with ${last.event.type}, but the workflow code ${found}`,
    ...at(last),
  };
}

async function replayOne(
  workflows: ReadonlyMap<string, ReplayableWorkflow>,
  target: HistoryToReplay,
  options: ReplayHistoriesOptions,
): Promise<HistoryReplayResult> {
  let parsed: ParsedHistory;
  try {
    parsed = parseHistoryExport(
      target.history,
      target.source,
      options.reader ?? currentEventReader,
    );
  } catch (error) {
    const sequence =
      error instanceof InvalidHistoryExportError && error.sequenceNumber !== undefined
        ? { sequenceNumber: error.sequenceNumber }
        : {};
    return {
      source: target.source,
      eventCount: 0,
      passed: false,
      problem: {
        kind: "invalid_history",
        message: error instanceof Error ? error.message : String(error),
        ...sequence,
      },
    };
  }
  const identity = {
    source: target.source,
    runId: parsed.runId,
    workflowType: parsed.workflowType,
    eventCount: parsed.events.length,
  };
  const workflow = workflows.get(parsed.workflowType);
  if (workflow === undefined) {
    return {
      ...identity,
      passed: false,
      problem: {
        kind: "unknown_workflow",
        message: `no workflow of type "${parsed.workflowType}" was given to replay against`,
      },
    };
  }
  const history = parsed.events.map((entry) => entry.event);
  const started = history[0];
  const lastAt = parsed.events.at(-1)?.createdAt ?? new Date(0);
  try {
    const decision = await runDecisionLoop(
      workflow.handler as unknown as WorkflowHandler,
      started?.type === "run_started" ? started.input : undefined,
      history,
      {
        clock: { now: () => lastAt },
        runId: parsed.runId,
        triggeredAt: lastAt,
        ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      },
    );
    const problem = checkClosed(decision, parsed.events);
    return problem === undefined
      ? { ...identity, passed: true }
      : { ...identity, passed: false, problem };
  } catch (error) {
    return { ...identity, passed: false, problem: problemOf(error, parsed.events) };
  }
}

/**
 * Replays each exported history against `workflows` (today's code) and
 * reports, per history, whether the code makes the same decisions the
 * history recorded. Every recorded command must be issued again, in the same
 * order and with the same type and input, and a history that closed its run
 * must close it the same way (completed, failed, cancelled or continued as
 * new) without the code issuing further commands. An open history may end
 * with new commands: they are what the run would do next. A failing history
 * names its run and, where possible, the event the replay diverged at. No
 * step body runs and no database is used; `ctx.random()` and `ctx.uuid()`
 * are seeded by the run id exactly as on a worker. Never rejects: problems
 * are reported in the result.
 */
export async function replayHistories(
  workflows: readonly ReplayableWorkflow[],
  histories: readonly HistoryToReplay[],
  options: ReplayHistoriesOptions = {},
): Promise<ReplayReport> {
  const byType = new Map(workflows.map((workflow) => [workflow.workflowType, workflow]));
  const results: HistoryReplayResult[] = [];
  for (const target of histories) {
    results.push(await replayOne(byType, target, options));
  }
  const passed = results.filter((result) => result.passed).length;
  return { results, passed, failed: results.length - passed };
}

/**
 * One line describing `result`, as `wf replay` prints it: `ok` or `FAIL`,
 * the run and the source, and for a failure its kind, the event and the
 * message.
 */
export function formatReplayResult(result: HistoryReplayResult): string {
  const subject = `run ${result.runId ?? "?"} (${result.source})`;
  if (result.passed) {
    return `ok    ${subject}: ${String(result.eventCount)} events replayed`;
  }
  const problem = result.problem;
  if (problem === undefined) {
    return `FAIL  ${subject}`;
  }
  const where =
    problem.sequenceNumber === undefined
      ? ""
      : ` at event ${String(problem.sequenceNumber)}${problem.eventType === undefined ? "" : ` (${problem.eventType})`}`;
  return `FAIL  ${subject}: ${problem.kind.replaceAll("_", " ")}${where}: ${problem.message}`;
}
