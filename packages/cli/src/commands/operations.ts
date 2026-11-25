import { CliError } from "../errors.ts";
import { readDevState, resolveClientConfig } from "../config.ts";
import type { CliIo } from "../io.ts";
import {
  createOperationsClient,
  type OperationsClient,
  type PauseSnapshot,
  type PauseSubject,
  type ScheduleSnapshot,
  type TriggerSnapshot,
} from "../operations-client.ts";
import { CLIENT_OPTIONS } from "./run.ts";
import {
  booleanFlag,
  parseCommand,
  parseJsonFlag,
  requirePositional,
  stringFlag,
  type ParsedCommand,
} from "./shared.ts";

/**
 * Hooks of `wf pause`, `wf resume`, `wf schedule`, `wf dlq` and
 * `wf quarantine`: tests hand in a client instead of a real api.
 */
export interface OperationsHooks {
  readonly operations?: OperationsClient;
}

const OVERLAP_POLICIES = ["skip", "buffer_one", "cancel_other", "allow_all"];
const CATCH_UP_POLICIES = ["latest_only", "all"];
const SCOPES = "run <id>, queue [name] or namespace";

async function operationsFor(
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

function subjectOf(parsed: ParsedCommand, verb: string): PauseSubject {
  const scope = parsed.positionals[0];
  switch (scope) {
    case "run":
      return { scope: "run", runId: requirePositional(parsed, 1, "run id") };
    case "queue": {
      const queueName = parsed.positionals[1];
      return queueName === undefined ? { scope: "queue" } : { scope: "queue", queueName };
    }
    case "namespace":
      return { scope: "namespace" };
    case undefined:
      throw new CliError(`missing what to ${verb}: ${SCOPES}`, 2);
    default:
      throw new CliError(`cannot ${verb} "${scope}": use ${SCOPES}`, 2);
  }
}

function describeSubject(pause: PauseSnapshot): string {
  if (pause.scope === "run") {
    return `run ${pause.runId ?? ""}`;
  }
  if (pause.scope === "queue") {
    return `queue ${pause.queueName ?? ""}`;
  }
  return "namespace";
}

function choiceFlag(
  parsed: ParsedCommand,
  name: string,
  choices: readonly string[],
): string | undefined {
  const value = stringFlag(parsed, name);
  if (value !== undefined && !choices.includes(value)) {
    throw new CliError(`--${name} must be one of ${choices.join(", ")}`, 2);
  }
  return value;
}

function instantFlag(parsed: ParsedCommand, name: string): string {
  const value = stringFlag(parsed, name);
  if (value === undefined) {
    throw new CliError(`missing --${name}: an ISO 8601 instant such as 2026-03-01T00:00:00Z`, 2);
  }
  const parsedValue = Date.parse(value);
  if (Number.isNaN(parsedValue)) {
    throw new CliError(`--${name} is not an ISO 8601 instant: ${value}`, 2);
  }
  return new Date(parsedValue).toISOString();
}

function printSchedule(io: CliIo, schedule: ScheduleSnapshot): void {
  io.stdout(`schedule   ${schedule.scheduleId}`);
  io.stdout(`name       ${schedule.name}`);
  io.stdout(`cron       ${schedule.cronExpression} (${schedule.timeZone})`);
  io.stdout(`workflow   ${schedule.workflowType}`);
  io.stdout(`state      ${schedule.state}`);
  io.stdout(`overlap    ${schedule.overlapPolicy}`);
  io.stdout(`catch up   ${schedule.catchUpPolicy}`);
  io.stdout(`next fire  ${schedule.nextFireAt ?? "-"}`);
  if (schedule.bufferedFor !== null) {
    io.stdout(`buffered   ${schedule.bufferedFor}`);
  }
  if (schedule.error !== null) {
    io.stdout(`error      ${schedule.error}`);
  }
}

function printTrigger(io: CliIo, trigger: TriggerSnapshot): void {
  const cancelled =
    trigger.cancelledRunIds === undefined || trigger.cancelledRunIds.length === 0
      ? ""
      : `  cancelled ${trigger.cancelledRunIds.join(", ")}`;
  io.stdout(
    `${trigger.scheduledFor}  ${trigger.outcome.padEnd(9)}${trigger.runId ?? ""}${cancelled}`,
  );
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
 * `wf pause run <id> | queue [name] | namespace` (`--reason text`) and
 * `wf pause list`: holds back work. Paused tasks stay queued and timers
 * still fire into them.
 */
export async function pauseCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, { ...CLIENT_OPTIONS, reason: { type: "string" } });
  if (parsed.positionals[0] === "list") {
    const client = await operationsFor(parsed, io, hooks);
    const pauses = await client.listPauses();
    return emit(parsed, io, { pauses }, () => {
      if (pauses.length === 0) {
        io.stdout("nothing is paused");
      }
      for (const pause of pauses) {
        const reason = pause.reason === null ? "" : `  ${pause.reason}`;
        io.stdout(`${describeSubject(pause).padEnd(46)}${pause.pausedAt}${reason}`);
      }
    });
  }
  const subject = subjectOf(parsed, "pause");
  const client = await operationsFor(parsed, io, hooks);
  const receipt = await client.pause(subject, stringFlag(parsed, "reason"));
  return emit(parsed, io, receipt, () => {
    const already = receipt.created ? "paused" : "already paused since";
    io.stdout(
      `${already} ${receipt.created ? describeSubject(receipt.pause) : receipt.pause.pausedAt}`,
    );
  });
}

/**
 * `wf resume run <id> | queue [name] | namespace`: releases paused work; the
 * next poll leases its tasks.
 */
export async function resumeCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, CLIENT_OPTIONS);
  const subject = subjectOf(parsed, "resume");
  const client = await operationsFor(parsed, io, hooks);
  const resumed = await client.resume(subject);
  return emit(parsed, io, { resumed }, () => {
    io.stdout(resumed ? "resumed" : "it was not paused");
  });
}

async function createSchedule(
  parsed: ParsedCommand,
  io: CliIo,
  client: OperationsClient,
): Promise<number> {
  const name = requirePositional(parsed, 1, "schedule name");
  const cronExpression = requirePositional(parsed, 2, "cron expression");
  const workflowType = requirePositional(parsed, 3, "workflow type");
  const timeZone = stringFlag(parsed, "time-zone");
  const overlapPolicy = choiceFlag(parsed, "overlap", OVERLAP_POLICIES);
  const catchUpPolicy = choiceFlag(parsed, "catch-up", CATCH_UP_POLICIES);
  const input = parseJsonFlag(stringFlag(parsed, "input"), "input");
  const schedule = await client.createSchedule({
    name,
    cronExpression,
    workflowType,
    ...(input === undefined ? {} : { input }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(overlapPolicy === undefined ? {} : { overlapPolicy }),
    ...(catchUpPolicy === undefined ? {} : { catchUpPolicy }),
  });
  return emit(parsed, io, schedule, () => {
    printSchedule(io, schedule);
  });
}

async function backfill(
  parsed: ParsedCommand,
  io: CliIo,
  client: OperationsClient,
): Promise<number> {
  const scheduleId = requirePositional(parsed, 1, "schedule id");
  const from = instantFlag(parsed, "from");
  const to = instantFlag(parsed, "to");
  const overlapPolicy = choiceFlag(parsed, "overlap", OVERLAP_POLICIES);
  const triggers = await client.backfill(scheduleId, {
    from,
    to,
    ...(overlapPolicy === undefined ? {} : { overlapPolicy }),
  });
  return emit(parsed, io, { triggers }, () => {
    for (const trigger of triggers) {
      printTrigger(io, trigger);
    }
    const started = triggers.filter((trigger) => trigger.outcome === "STARTED").length;
    io.stdout(`${String(triggers.length)} triggers handled, ${String(started)} runs started`);
  });
}

/**
 * `wf schedule create|list|describe|pause|resume|backfill`: manages cron
 * schedules through the api.
 */
export async function scheduleCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...CLIENT_OPTIONS,
    input: { type: "string" },
    "time-zone": { type: "string" },
    overlap: { type: "string" },
    "catch-up": { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  });
  const action = parsed.positionals[0];
  const actions = "create, list, describe, pause, resume or backfill";
  if (action === undefined) {
    throw new CliError(`missing schedule action: ${actions}`, 2);
  }
  const client = await operationsFor(parsed, io, hooks);
  switch (action) {
    case "create":
      return createSchedule(parsed, io, client);
    case "list": {
      const schedules = await client.listSchedules();
      return emit(parsed, io, { schedules }, () => {
        if (schedules.length === 0) {
          io.stdout("no schedules");
        }
        for (const schedule of schedules) {
          io.stdout(
            `${schedule.scheduleId}  ${schedule.state.padEnd(8)}${schedule.name.padEnd(24)}${schedule.cronExpression.padEnd(16)}${schedule.nextFireAt ?? "-"}`,
          );
        }
      });
    }
    case "describe": {
      const scheduleId = requirePositional(parsed, 1, "schedule id");
      const schedule = await client.getSchedule(scheduleId);
      const triggers = await client.listTriggers(scheduleId, 10);
      return emit(parsed, io, { ...schedule, triggers }, () => {
        printSchedule(io, schedule);
        for (const trigger of triggers) {
          printTrigger(io, trigger);
        }
      });
    }
    case "pause":
    case "resume": {
      const scheduleId = requirePositional(parsed, 1, "schedule id");
      const schedule =
        action === "pause"
          ? await client.pauseSchedule(scheduleId)
          : await client.resumeSchedule(scheduleId);
      return emit(parsed, io, schedule, () => {
        io.stdout(
          `schedule ${schedule.name} is ${schedule.state}, next fire ${schedule.nextFireAt ?? "-"}`,
        );
      });
    }
    case "backfill":
      return backfill(parsed, io, client);
    default:
      throw new CliError(`unknown schedule action "${action}": use ${actions}`, 2);
  }
}

/**
 * `wf dlq list` and `wf dlq requeue <id>`: shows the step tasks that ran out
 * of attempts and puts one back on its queue with a fresh retry budget.
 */
export async function dlqCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, CLIENT_OPTIONS);
  const action = parsed.positionals[0];
  if (action !== "list" && action !== "requeue") {
    throw new CliError(
      action === undefined
        ? "missing dlq action: list or requeue"
        : `unknown dlq action "${action}": use list or requeue`,
      2,
    );
  }
  if (action === "requeue") {
    const deadLetterId = requirePositional(parsed, 1, "dead letter id");
    const client = await operationsFor(parsed, io, hooks);
    const taskId = await client.requeueDeadLetter(deadLetterId);
    return emit(parsed, io, { taskId }, () => {
      io.stdout(`requeued ${deadLetterId} as task ${taskId}`);
    });
  }
  const client = await operationsFor(parsed, io, hooks);
  const deadLetters = await client.listDeadLetters();
  return emit(parsed, io, { deadLetters }, () => {
    if (deadLetters.length === 0) {
      io.stdout("the dead letter queue is empty");
    }
    for (const letter of deadLetters) {
      io.stdout(
        `${letter.id}  run ${letter.runId}  step ${letter.stepId}  ${String(letter.attempts)} attempts  ${letter.error.name}: ${letter.error.message}`,
      );
    }
  });
}

/**
 * `wf quarantine list` and `wf quarantine release <task id>`: shows the
 * tasks that are no longer delivered and puts one back on its queue.
 */
export async function quarantineCommand(
  args: readonly string[],
  io: CliIo,
  hooks: OperationsHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, CLIENT_OPTIONS);
  const action = parsed.positionals[0];
  if (action !== "list" && action !== "release") {
    throw new CliError(
      action === undefined
        ? "missing quarantine action: list or release"
        : `unknown quarantine action "${action}": use list or release`,
      2,
    );
  }
  if (action === "release") {
    const taskId = requirePositional(parsed, 1, "task id");
    const client = await operationsFor(parsed, io, hooks);
    const runId = await client.releaseQuarantined(taskId);
    return emit(parsed, io, { taskId, runId }, () => {
      io.stdout(`released task ${taskId} of run ${runId}`);
    });
  }
  const client = await operationsFor(parsed, io, hooks);
  const tasks = await client.listQuarantined();
  return emit(parsed, io, { tasks }, () => {
    if (tasks.length === 0) {
      io.stdout("no task is quarantined");
    }
    for (const task of tasks) {
      io.stdout(
        `${task.taskId}  run ${task.runId}  ${task.taskType.padEnd(14)}${task.quarantinedAt}  ${task.reason}`,
      );
    }
  });
}
