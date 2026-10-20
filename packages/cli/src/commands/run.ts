import { CliError } from "../errors.js";
import { readDevState, resolveClientConfig } from "../config.js";
import type { CliIo } from "../io.js";
import { createApiClient, type RunClient, type RunSnapshot } from "../run-client.js";
import {
  booleanFlag,
  parseCommand,
  parseJsonFlag,
  requirePositional,
  stringFlag,
  type ParsedCommand,
} from "./shared.js";

const CLIENT_OPTIONS = {
  "api-url": { type: "string" },
  "api-key": { type: "string" },
  json: { type: "boolean" },
} as const;

/**
 * Hooks of `wf run`: tests hand in a client instead of a real api.
 */
export interface RunHooks {
  readonly client?: RunClient;
}

async function clientFor(parsed: ParsedCommand, io: CliIo, hooks: RunHooks): Promise<RunClient> {
  if (hooks.client !== undefined) {
    return hooks.client;
  }
  const config = resolveClientConfig({
    apiUrl: stringFlag(parsed, "api-url"),
    apiKey: stringFlag(parsed, "api-key"),
    env: io.env,
    devState: await readDevState(io.cwd),
  });
  return createApiClient({ baseUrl: config.apiUrl, apiKey: config.apiKey });
}

function printRun(io: CliIo, run: RunSnapshot): void {
  io.stdout(`run        ${run.runId}`);
  io.stdout(`workflow   ${run.workflowType}`);
  io.stdout(`status     ${run.status}`);
  io.stdout(`started    ${run.startedAt}`);
  if (run.closedAt !== null) {
    io.stdout(`closed     ${run.closedAt}`);
  }
  if (run.input !== undefined) {
    io.stdout(`input      ${JSON.stringify(run.input)}`);
  }
  if (run.result !== undefined && run.result !== null) {
    io.stdout(`result     ${JSON.stringify(run.result)}`);
  }
  if (run.error !== undefined && run.error !== null) {
    io.stdout(`error      ${run.error.name}: ${run.error.message}`);
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

async function startRun(parsed: ParsedCommand, io: CliIo, client: RunClient): Promise<number> {
  const workflowType = requirePositional(parsed, 1, "workflow type");
  const input = parseJsonFlag(stringFlag(parsed, "input"), "input");
  const runId = await client.start(workflowType, input, stringFlag(parsed, "idempotency-key"));
  if (booleanFlag(parsed, "wait")) {
    const closed = await client.waitForClose(runId);
    if (booleanFlag(parsed, "json")) {
      io.stdout(JSON.stringify(closed));
    } else {
      printRun(io, closed);
    }
    return closed.status === "COMPLETED" ? 0 : 1;
  }
  io.stdout(booleanFlag(parsed, "json") ? JSON.stringify({ runId }) : runId);
  return 0;
}

async function listRuns(parsed: ParsedCommand, io: CliIo, client: RunClient): Promise<number> {
  const status = stringFlag(parsed, "status");
  const workflowType = stringFlag(parsed, "type");
  const limit = stringFlag(parsed, "limit");
  const cursor = stringFlag(parsed, "cursor");
  const page = await client.listRuns({
    ...(cursor === undefined ? {} : { cursor }),
    ...(status === undefined ? {} : { status }),
    ...(workflowType === undefined ? {} : { workflowType }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  });
  if (booleanFlag(parsed, "json")) {
    io.stdout(JSON.stringify(page));
    return 0;
  }
  if (page.runs.length === 0) {
    io.stdout("no runs");
    return 0;
  }
  for (const run of page.runs) {
    io.stdout(
      `${pad(run.runId, 38)}${pad(run.status, 14)}${pad(run.workflowType, 24)}${run.startedAt}`,
    );
  }
  if (page.nextCursor !== undefined) {
    io.stdout(`more runs follow, pass --cursor ${page.nextCursor}`);
  }
  return 0;
}

/**
 * `wf run start|signal|cancel|describe|list`: drives runs through the api.
 * The api address and key come from `--api-url` and `--api-key`, the
 * environment (`WF_API_URL`, `WF_API_KEY`) or the state `wf dev` left in
 * the current directory.
 */
export async function runCommand(
  args: readonly string[],
  io: CliIo,
  hooks: RunHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...CLIENT_OPTIONS,
    input: { type: "string" },
    payload: { type: "string" },
    reason: { type: "string" },
    status: { type: "string" },
    type: { type: "string" },
    limit: { type: "string" },
    cursor: { type: "string" },
    "idempotency-key": { type: "string" },
    wait: { type: "boolean" },
    history: { type: "boolean" },
  });
  const action = parsed.positionals[0];
  if (action === undefined) {
    throw new CliError("missing run action: start, signal, cancel, describe or list", 2);
  }
  const client = await clientFor(parsed, io, hooks);
  switch (action) {
    case "start":
      return startRun(parsed, io, client);
    case "signal": {
      const runId = requirePositional(parsed, 1, "run id");
      const name = requirePositional(parsed, 2, "signal name");
      await client.signal(runId, name, parseJsonFlag(stringFlag(parsed, "payload"), "payload"));
      io.stdout(`signalled ${runId} with ${name}`);
      return 0;
    }
    case "cancel": {
      const runId = requirePositional(parsed, 1, "run id");
      await client.cancel(runId, stringFlag(parsed, "reason"));
      io.stdout(`cancellation requested for ${runId}`);
      return 0;
    }
    case "describe": {
      const runId = requirePositional(parsed, 1, "run id");
      const run = await client.describe(runId);
      if (booleanFlag(parsed, "json")) {
        io.stdout(JSON.stringify(run));
      } else {
        printRun(io, run);
      }
      if (booleanFlag(parsed, "history")) {
        for (const item of await client.history(runId)) {
          io.stdout(`${pad(String(item.sequenceNumber), 5)}${item.event.type}`);
        }
      }
      return 0;
    }
    case "list":
      return listRuns(parsed, io, client);
    default:
      throw new CliError(
        `unknown run action "${action}": use start, signal, cancel, describe or list`,
        2,
      );
  }
}
