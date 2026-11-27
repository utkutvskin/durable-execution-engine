import { CliError } from "../errors.ts";
import type { CliIo } from "../io.ts";
import {
  createOperationsClient,
  type BatchDefinition,
  type BatchSnapshot,
  type OperationsClient,
  type ResetPointInput,
  type ResetSnapshot,
} from "../operations-client.ts";
import { readDevState, resolveClientConfig } from "../config.ts";
import { CLIENT_OPTIONS } from "./run.ts";
import {
  booleanFlag,
  parseCommand,
  parseJsonFlag,
  requirePositional,
  stringFlag,
  type ParsedCommand,
} from "./shared.ts";
import type { OperationsHooks } from "./operations.ts";

const POINT_OPTIONS = {
  ...CLIENT_OPTIONS,
  event: { type: "string" },
  step: { type: "string" },
  "failed-step": { type: "boolean" },
  reason: { type: "string" },
} as const;

const BATCH_OPERATIONS: readonly BatchDefinition["operation"][] = [
  "cancel",
  "terminate",
  "signal",
  "reset",
  "requeue",
];

async function clientFor(
  parsed: ParsedCommand,
  io: CliIo,
  hooks: OperationsHooks,
): Promise<OperationsClient> {
  if (hooks.operations !== undefined) {
    return hooks.operations;
  }
  const config = resolveClientConfig({
    apiUrl: stringFlag(parsed, "api-url"),
    apiKey: stringFlag(parsed, "api-key"),
    env: io.env,
    devState: await readDevState(io.cwd),
  });
  return createOperationsClient({ baseUrl: config.apiUrl, apiKey: config.apiKey });
}

function positiveInteger(parsed: ParsedCommand, flag: string): number | undefined {
  const text = stringFlag(parsed, flag);
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(`--${flag} must be a positive integer, got "${text}"`, 2);
  }
  return value;
}

function positiveNumber(parsed: ParsedCommand, flag: string): number | undefined {
  const text = stringFlag(parsed, flag);
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`--${flag} must be a positive number, got "${text}"`, 2);
  }
  return value;
}

/**
 * Reads the cut a command names from `--event n`, `--step n` or
 * `--failed-step`, exactly one of them. `allowEvent` is false for batches.
 */
export function resetPointOf(
  parsed: ParsedCommand,
  allowEvent = true,
): ResetPointInput | undefined {
  const event = positiveInteger(parsed, "event");
  const step = positiveInteger(parsed, "step");
  const failed = booleanFlag(parsed, "failed-step");
  const given = [event !== undefined, step !== undefined, failed].filter(Boolean).length;
  if (given > 1) {
    throw new CliError("pass only one of --event, --step and --failed-step", 2);
  }
  if (event !== undefined) {
    if (!allowEvent) {
      throw new CliError("a batch reset takes --step n or --failed-step, not --event", 2);
    }
    return { kind: "event", sequence: event };
  }
  if (step !== undefined) {
    return { kind: "step", step };
  }
  return failed ? { kind: "failed-step" } : undefined;
}

function requirePoint(parsed: ParsedCommand, command: string): ResetPointInput {
  const point = resetPointOf(parsed);
  if (point === undefined) {
    throw new CliError(`${command} needs a cut: --event n, --step n or --failed-step`, 2);
  }
  return point;
}

function printReset(io: CliIo, receipt: ResetSnapshot): void {
  io.stdout(
    `${receipt.kind === "reset" ? "reset" : "forked"} ${receipt.resetFromRunId} to new run ${receipt.runId} (${receipt.workflowType}, events 1-${String(receipt.eventSequence)} copied)`,
  );
  if (receipt.terminatedOriginal) {
    io.stdout(`terminated ${receipt.resetFromRunId}`);
  }
  if (receipt.rescheduledSteps.length > 0) {
    io.stdout(`runs again: ${receipt.rescheduledSteps.join(", ")}`);
  }
}

function emit(parsed: ParsedCommand, io: CliIo, value: unknown, text: () => void): number {
  if (booleanFlag(parsed, "json")) {
    io.stdout(JSON.stringify(value));
  } else {
    text();
  }
  return 0;
}

/**
 * `wf reset <run id> --event n | --step n | --failed-step [--reason text]`:
 * replaces a run with a new one whose history is copied up to the cut. An
 * open run is terminated.
 */
export async function resetCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, POINT_OPTIONS);
  const runId = requirePositional(parsed, 0, "run id");
  const point = requirePoint(parsed, "wf reset");
  const client = await clientFor(parsed, io, hooks);
  const receipt = await client.resetRun(runId, point, stringFlag(parsed, "reason"));
  return emit(parsed, io, receipt, () => {
    printReset(io, receipt);
  });
}

/**
 * `wf fork <run id> --event n | --step n | --failed-step [--workflow-type t]`:
 * starts a new run whose history is copied up to the cut, optionally under
 * another workflow type, and leaves the run as it is.
 */
export async function forkCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, { ...POINT_OPTIONS, "workflow-type": { type: "string" } });
  const runId = requirePositional(parsed, 0, "run id");
  const point = requirePoint(parsed, "wf fork");
  const client = await clientFor(parsed, io, hooks);
  const receipt = await client.forkRun(runId, point, stringFlag(parsed, "workflow-type"));
  return emit(parsed, io, receipt, () => {
    printReset(io, receipt);
  });
}

function batchLine(batch: BatchSnapshot): string {
  return `${batch.batchId}  ${batch.operation.padEnd(10)}${batch.status.padEnd(11)}${String(batch.applied)} applied, ${String(batch.skipped)} skipped, ${String(batch.remaining)} left of ${String(batch.total)}  ${batch.query === "" ? "(every run)" : batch.query}`;
}

function batchDefinitionOf(parsed: ParsedCommand): BatchDefinition {
  const operation = requirePositional(parsed, 1, "batch operation");
  if (!BATCH_OPERATIONS.includes(operation as BatchDefinition["operation"])) {
    throw new CliError(
      `unknown batch operation "${operation}": use ${BATCH_OPERATIONS.join(", ")}`,
      2,
    );
  }
  const query = stringFlag(parsed, "query");
  if (query === undefined) {
    throw new CliError(`wf batch start needs --query (pass --query "" for every run)`, 2);
  }
  const signalName = stringFlag(parsed, "signal");
  const point = resetPointOf(parsed, false);
  const reason = stringFlag(parsed, "reason");
  const runsPerSecond = positiveNumber(parsed, "rate");
  const pageSize = positiveInteger(parsed, "page-size");
  return {
    operation: operation as BatchDefinition["operation"],
    query,
    ...(reason === undefined ? {} : { reason }),
    ...(signalName === undefined
      ? {}
      : {
          signal: {
            name: signalName,
            payload: parseJsonFlag(stringFlag(parsed, "payload"), "payload") ?? null,
          },
        }),
    ...(point === undefined || point.kind === "event" ? {} : { resetPoint: point }),
    ...(runsPerSecond === undefined ? {} : { runsPerSecond }),
    ...(pageSize === undefined ? {} : { pageSize }),
  };
}

/**
 * `wf batch start <operation> --query q`, `wf batch list` and
 * `wf batch show <id> [--targets]`: runs cancel, terminate, signal
 * (`--signal name --payload json`), reset (`--step n` or `--failed-step`)
 * or requeue over the runs a visibility query matches, as a durable batch
 * paced by `--rate` runs per second, and shows its progress.
 */
export async function batchCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...POINT_OPTIONS,
    query: { type: "string" },
    signal: { type: "string" },
    payload: { type: "string" },
    rate: { type: "string" },
    "page-size": { type: "string" },
    targets: { type: "boolean" },
  });
  const action = parsed.positionals[0];
  switch (action) {
    case "start": {
      const definition = batchDefinitionOf(parsed);
      const client = await clientFor(parsed, io, hooks);
      const batch = await client.startBatch(definition);
      return emit(parsed, io, batch, () => {
        io.stdout(
          `started batch ${batch.batchId}: ${batch.operation} over ${String(batch.total)} runs (workflow run ${batch.runId})`,
        );
      });
    }
    case "list": {
      const client = await clientFor(parsed, io, hooks);
      const batches = await client.listBatches();
      return emit(parsed, io, { batches }, () => {
        if (batches.length === 0) {
          io.stdout("no batch operation yet");
        }
        for (const batch of batches) {
          io.stdout(batchLine(batch));
        }
      });
    }
    case "show": {
      const batchId = requirePositional(parsed, 1, "batch id");
      const client = await clientFor(parsed, io, hooks);
      const batch = await client.getBatch(batchId);
      const targets = booleanFlag(parsed, "targets")
        ? await client.listBatchTargets(batchId, { limit: 500 })
        : undefined;
      return emit(parsed, io, targets === undefined ? batch : { ...batch, targets }, () => {
        io.stdout(batchLine(batch));
        for (const target of targets ?? []) {
          io.stdout(
            `${String(target.position).padStart(6)}  ${target.runId}  ${target.state.padEnd(8)}${target.detail ?? ""}`,
          );
        }
      });
    }
    default:
      throw new CliError(
        action === undefined
          ? "missing batch action: start, list or show"
          : `unknown batch action "${action}": use start, list or show`,
        2,
      );
  }
}
