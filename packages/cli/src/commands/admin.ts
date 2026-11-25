import { CliError } from "../errors.ts";
import { readDevState, resolveClientConfig } from "../config.ts";
import type { CliIo } from "../io.ts";
import {
  createAdminClient,
  type AdminClient,
  type KeyScope,
  type KeySnapshot,
  type QuotaLimits,
  type QuotaSnapshot,
} from "../admin-client.ts";
import { CLIENT_OPTIONS } from "./run.ts";
import {
  booleanFlag,
  parseCommand,
  requirePositional,
  stringFlag,
  type OptionSpec,
  type ParsedCommand,
} from "./shared.ts";

/**
 * Hooks of `wf namespace`, `wf keys`, `wf quota` and `wf audit`: tests hand
 * in a client instead of a real api, and a clock for `--expires-in`.
 */
export interface AdminHooks {
  readonly admin?: AdminClient;
  readonly now?: () => Date;
}

const SCOPES: readonly KeyScope[] = ["read", "operate", "admin"];

const QUOTA_FLAGS = {
  "max-concurrent-runs": "maxConcurrentRuns",
  "max-pending-tasks": "maxPendingTasks",
  "rate-per-second": "ratePerSecond",
  burst: "burst",
} as const satisfies Record<string, keyof QuotaLimits>;

async function adminFor(parsed: ParsedCommand, io: CliIo, hooks: AdminHooks): Promise<AdminClient> {
  if (hooks.admin !== undefined) {
    return hooks.admin;
  }
  const config = resolveClientConfig({
    apiUrl: stringFlag(parsed, "api-url"),
    apiKey: stringFlag(parsed, "api-key"),
    env: io.env,
    devState: await readDevState(io.cwd),
  });
  return createAdminClient({ baseUrl: config.apiUrl, apiKey: config.apiKey });
}

function emit(parsed: ParsedCommand, io: CliIo, value: unknown, text: () => void): number {
  if (booleanFlag(parsed, "json")) {
    io.stdout(JSON.stringify(value));
  } else {
    text();
  }
  return 0;
}

function requireAction(parsed: ParsedCommand, command: string, actions: readonly string[]): string {
  const action = parsed.positionals[0];
  const choices = actions.join(", ");
  if (action === undefined) {
    throw new CliError(`missing ${command} action: ${choices}`, 2);
  }
  if (!actions.includes(action)) {
    throw new CliError(`unknown ${command} action "${action}": use ${choices}`, 2);
  }
  return action;
}

/**
 * `wf namespace create <name>` and `wf namespace list`. Needs an admin key.
 */
export async function namespaceCommand(
  args: readonly string[],
  io: CliIo,
  hooks: AdminHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, CLIENT_OPTIONS);
  const action = requireAction(parsed, "namespace", ["create", "list"]);
  if (action === "create") {
    const name = requirePositional(parsed, 1, "namespace name");
    const client = await adminFor(parsed, io, hooks);
    const result = await client.createNamespace(name);
    return emit(parsed, io, result, () => {
      io.stdout(result.created ? `created namespace ${name}` : `namespace ${name} exists already`);
    });
  }
  const client = await adminFor(parsed, io, hooks);
  const namespaces = await client.listNamespaces();
  return emit(parsed, io, { namespaces }, () => {
    for (const namespace of namespaces) {
      io.stdout(
        `${namespace.name.padEnd(32)}${String(namespace.activeKeys).padStart(4)} active keys  created ${namespace.createdAt}`,
      );
    }
  });
}

function expiryOf(parsed: ParsedCommand, hooks: AdminHooks): string | undefined {
  const at = stringFlag(parsed, "expires-at");
  const inSeconds = stringFlag(parsed, "expires-in");
  if (at !== undefined && inSeconds !== undefined) {
    throw new CliError("give either --expires-at or --expires-in, not both", 2);
  }
  if (at !== undefined) {
    const parsedAt = Date.parse(at);
    if (Number.isNaN(parsedAt)) {
      throw new CliError(`--expires-at is not an ISO 8601 instant: ${at}`, 2);
    }
    return new Date(parsedAt).toISOString();
  }
  if (inSeconds !== undefined) {
    if (!/^[1-9]\d*$/.test(inSeconds)) {
      throw new CliError("--expires-in must be a positive number of seconds", 2);
    }
    const now = hooks.now?.() ?? new Date();
    return new Date(now.getTime() + Number(inSeconds) * 1000).toISOString();
  }
  return undefined;
}

function printKey(io: CliIo, key: KeySnapshot): void {
  const state =
    key.revokedAt !== null
      ? `revoked ${key.revokedAt}`
      : key.expiresAt === null
        ? "no expiry"
        : `expires ${key.expiresAt}`;
  io.stdout(
    `${key.keyId}  ${key.scope.padEnd(8)}${(key.label === "" ? "-" : key.label).padEnd(20)}${state}  last used ${key.lastUsedAt ?? "never"}`,
  );
}

/**
 * `wf keys issue <namespace> --scope s` (`--label l`, `--expires-in s` or
 * `--expires-at instant`), `wf keys list <namespace>` and
 * `wf keys revoke <key id>`. Needs an admin key. The issued secret is
 * printed once.
 */
export async function keysCommand(
  args: readonly string[],
  io: CliIo,
  hooks: AdminHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...CLIENT_OPTIONS,
    scope: { type: "string" },
    label: { type: "string" },
    "expires-in": { type: "string" },
    "expires-at": { type: "string" },
  });
  const action = requireAction(parsed, "keys", ["issue", "list", "revoke"]);
  switch (action) {
    case "issue": {
      const namespace = requirePositional(parsed, 1, "namespace name");
      const scope = stringFlag(parsed, "scope");
      if (scope === undefined || !SCOPES.includes(scope as KeyScope)) {
        throw new CliError(`--scope must be one of ${SCOPES.join(", ")}`, 2);
      }
      const label = stringFlag(parsed, "label");
      const expiresAt = expiryOf(parsed, hooks);
      const client = await adminFor(parsed, io, hooks);
      const issued = await client.issueKey(namespace, {
        scope: scope as KeyScope,
        ...(label === undefined ? {} : { label }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      return emit(parsed, io, issued, () => {
        io.stdout(issued.key);
        io.stdout(
          `key ${issued.keyId} for ${issued.namespace}, scope ${issued.scope}, ${issued.expiresAt === null ? "no expiry" : `expires ${issued.expiresAt}`}; the secret above is not shown again`,
        );
      });
    }
    case "list": {
      const namespace = requirePositional(parsed, 1, "namespace name");
      const client = await adminFor(parsed, io, hooks);
      const keys = await client.listKeys(namespace);
      return emit(parsed, io, { keys }, () => {
        if (keys.length === 0) {
          io.stdout(`namespace ${namespace} has no keys`);
        }
        for (const key of keys) {
          printKey(io, key);
        }
      });
    }
    default: {
      const keyId = requirePositional(parsed, 1, "key id");
      const client = await adminFor(parsed, io, hooks);
      const revoked = await client.revokeKey(keyId);
      return emit(parsed, io, revoked, () => {
        io.stdout(`revoked key ${revoked.keyId} of ${revoked.namespace}`);
      });
    }
  }
}

function limitOf(name: string, value: string): number | null {
  if (value === "none") {
    return null;
  }
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number < 0) {
    throw new CliError(`--${name} must be a non negative number or none`, 2);
  }
  return number;
}

function printQuota(io: CliIo, snapshot: QuotaSnapshot): void {
  const show = (value: number | null): string => (value === null ? "none" : String(value));
  io.stdout(`namespace            ${snapshot.namespace}`);
  io.stdout(
    `max concurrent runs  ${show(snapshot.quota.maxConcurrentRuns)} (open ${String(snapshot.usage.openRuns)})`,
  );
  io.stdout(
    `max pending tasks    ${show(snapshot.quota.maxPendingTasks)} (pending ${String(snapshot.usage.pendingTasks)})`,
  );
  io.stdout(`rate per second      ${show(snapshot.quota.ratePerSecond)}`);
  io.stdout(`burst                ${show(snapshot.quota.burst)}`);
}

/**
 * `wf quota get <namespace>` and `wf quota set <namespace>` with any of
 * `--max-concurrent-runs`, `--max-pending-tasks`, `--rate-per-second` and
 * `--burst` (a number, or `none` to remove the limit). Needs an admin key.
 */
export async function quotaCommand(
  args: readonly string[],
  io: CliIo,
  hooks: AdminHooks = {},
): Promise<number> {
  const options: OptionSpec = { ...CLIENT_OPTIONS };
  for (const flag of Object.keys(QUOTA_FLAGS)) {
    options[flag] = { type: "string" };
  }
  const parsed = parseCommand(args, options);
  const action = requireAction(parsed, "quota", ["get", "set"]);
  const namespace = requirePositional(parsed, 1, "namespace name");
  if (action === "get") {
    const client = await adminFor(parsed, io, hooks);
    const snapshot = await client.getQuota(namespace);
    return emit(parsed, io, snapshot, () => {
      printQuota(io, snapshot);
    });
  }
  const changes: Partial<Record<keyof QuotaLimits, number | null>> = {};
  for (const [flag, field] of Object.entries(QUOTA_FLAGS)) {
    const value = stringFlag(parsed, flag);
    if (value !== undefined) {
      changes[field] = limitOf(flag, value);
    }
  }
  if (Object.keys(changes).length === 0) {
    throw new CliError(
      `quota set needs at least one of ${Object.keys(QUOTA_FLAGS)
        .map((flag) => `--${flag}`)
        .join(", ")}`,
      2,
    );
  }
  const client = await adminFor(parsed, io, hooks);
  const snapshot = await client.setQuota(namespace, changes);
  return emit(parsed, io, snapshot, () => {
    printQuota(io, snapshot);
  });
}

/**
 * `wf audit list` (`--namespace name`, `--limit n`): the latest admin and
 * operator actions, newest first, with the key that made each. Needs an
 * admin key.
 */
export async function auditCommand(
  args: readonly string[],
  io: CliIo,
  hooks: AdminHooks = {},
): Promise<number> {
  const parsed = parseCommand(args, {
    ...CLIENT_OPTIONS,
    namespace: { type: "string" },
    limit: { type: "string" },
  });
  requireAction(parsed, "audit", ["list"]);
  const limitText = stringFlag(parsed, "limit");
  if (limitText !== undefined && !/^[1-9]\d{0,2}$/.test(limitText)) {
    throw new CliError("--limit must be a whole number from 1 to 500", 2);
  }
  const namespace = stringFlag(parsed, "namespace");
  const client = await adminFor(parsed, io, hooks);
  const entries = await client.listAudit({
    ...(namespace === undefined ? {} : { namespace }),
    ...(limitText === undefined ? {} : { limit: Math.min(500, Number(limitText)) }),
  });
  return emit(parsed, io, { entries }, () => {
    if (entries.length === 0) {
      io.stdout("the audit log is empty");
    }
    for (const entry of entries) {
      const actor = `${entry.actor.label === "" ? entry.actor.keyId : entry.actor.label} (${entry.actor.scope}@${entry.actor.namespace})`;
      io.stdout(
        `${entry.occurredAt}  ${entry.action.padEnd(20)}${(entry.namespace ?? "-").padEnd(20)}${(entry.target ?? "-").padEnd(38)}${actor}`,
      );
    }
  });
}
