import { CliError } from "../errors.ts";
import { readDevState, resolveClientConfig } from "../config.ts";
import type { CliIo } from "../io.ts";
import {
  MAX_LIST_LIMIT,
  createApiClient,
  type RunClient,
  type RunSnapshot,
} from "../run-client.ts";
import {
  booleanFlag,
  parseCommand,
  parseJsonFlag,
  requirePositional,
  stringFlag,
  type ParsedCommand,
} from "./shared.ts";

/**
 * Hooks of `wf run`: tests hand in a client instead of a real api.
 */
export interface RunHooks {
  readonly client?: RunClient;
}

/**
 * The options that choose the api a client command talks to.
 */
export const CLIENT_OPTIONS = {
  "api-url": { type: "string" },
  "api-key": { type: "string" },
  json: { type: "boolean" },
} as const;

/**
 * The `RunClient` of a command: the hook's client in tests, otherwise one
 * for the api named by `--api-url` and `--api-key`, the environment or the
 * state `wf dev` left in the current directory.
 */
export async function clientFor(
  parsed: ParsedCommand,
  io: CliIo,
  hooks: RunHooks,
): Promise<RunClient> {
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

function waitMsFlag(parsed: ParsedCommand): number | undefined {
  const text = stringFlag(parsed, "wait-ms");
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!/^\d+$/.test(text) || value > 60_000) {
    throw new CliError("--wait-ms must be a whole number of milliseconds up to 60000", 2);
  }
  return value;
}

async function updateRun(parsed: ParsedCommand, io: CliIo, client: RunClient): Promise<number> {
  const runId = requirePositional(parsed, 1, "run id");
  const name = requirePositional(parsed, 2, "update name");
  const updateId = stringFlag(parsed, "update-id");
  const waitMs = waitMsFlag(parsed);
  const answer = await client.update(
    runId,
    name,
    parseJsonFlag(stringFlag(parsed, "argument"), "argument"),
    {
      ...(updateId === undefined ? {} : { updateId }),
      ...(waitMs === undefined ? {} : { waitMs }),
    },
  );
  if (booleanFlag(parsed, "json")) {
    io.stdout(JSON.stringify(answer));
  } else if (answer.status === "completed") {
    io.stdout(JSON.stringify(answer.result ?? null));
  } else if (answer.status === "failed") {
    io.stderr(
      `update ${answer.updateId} failed: ${answer.error?.name ?? "Error"}: ${answer.error?.message ?? ""}`,
    );
  } else {
    io.stderr(`update ${answer.updateId} was accepted but has not finished yet`);
  }
  return answer.status === "completed" ? 0 : 1;
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

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new CliError(`--limit must be a whole number from 1 to ${String(MAX_LIST_LIMIT)}`, 2);
  }
  return value;
}

async function listRuns(parsed: ParsedCommand, io: CliIo, client: RunClient): Promise<number> {
  const status = stringFlag(parsed, "status");
  const workflowType = stringFlag(parsed, "type");
  const limit = parseLimit(stringFlag(parsed, "limit"));
  const cursor = stringFlag(parsed, "cursor");
  const page = await client.listRuns({
    ...(cursor === undefined ? {} : { cursor }),
    ...(status === undefined ? {} : { status }),
    ...(workflowType === undefined ? {} : { workflowType }),
    ...(limit === undefined ? {} : { limit }),
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
 * `wf run start|signal|update|query|cancel|describe|list`: drives runs
 * through the api.
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
    argument: { type: "string" },
    "update-id": { type: "string" },
    "wait-ms": { type: "string" },
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
    throw new CliError(
      "missing run action: start, signal, update, query, cancel, describe or list",
      2,
    );
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
    case "update":
      return updateRun(parsed, io, client);
    case "query": {
      const runId = requirePositional(parsed, 1, "run id");
      const name = requirePositional(parsed, 2, "query name");
      const result = await client.query(
        runId,
        name,
        parseJsonFlag(stringFlag(parsed, "argument"), "argument"),
      );
      io.stdout(JSON.stringify(result ?? null));
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
        `unknown run action "${action}": use start, signal, update, query, cancel, describe or list`,
        2,
      );
  }
}
