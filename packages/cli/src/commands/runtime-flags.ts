import {
  createLogger,
  createTracingProvider,
  type LogLevel,
  type Logger,
  type NamespaceQuota,
  type RetentionPolicy,
  type TracingProvider,
} from "@dee/core";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import { stringFlag, type OptionSpec, type ParsedCommand } from "./shared.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Options shared by the long running commands (`serve` and `worker`):
 * connection pool size, log level and format, and the tracing endpoint.
 */
export const RUNTIME_OPTIONS = {
  "pool-size": { type: "string" },
  "log-level": { type: "string" },
  "log-format": { type: "string" },
  "otlp-endpoint": { type: "string" },
  "sampling-ratio": { type: "string" },
} as const satisfies OptionSpec;

/**
 * Options of `serve` that set the limits of its namespace and the api.
 */
export const QUOTA_OPTIONS = {
  "max-concurrent-runs": { type: "string" },
  "max-pending-tasks": { type: "string" },
  "rate-per-second": { type: "string" },
  burst: { type: "string" },
  "max-queue-depth": { type: "string" },
  "metrics-token": { type: "string" },
  "metrics-cache-ms": { type: "string" },
} as const satisfies OptionSpec;

/**
 * Options of `worker` that schedule the history compactor.
 */
export const COMPACTION_OPTIONS = {
  "compact-interval": { type: "string" },
  "compact-retention": { type: "string" },
  "compact-tail-events": { type: "string" },
  "compact-batch": { type: "string" },
} as const satisfies OptionSpec;

/**
 * Options of `worker` for the health and metrics port.
 */
export const OPS_OPTIONS = {
  "health-port": { type: "string" },
  "health-host": { type: "string" },
  "metrics-token": { type: "string" },
} as const satisfies OptionSpec;

/**
 * The value of a flag, else the environment variable `WF_` plus the flag
 * name in upper case with `_` for `-` (`--pool-size` is `WF_POOL_SIZE`).
 */
export function flagOrEnv(parsed: ParsedCommand, name: string, env: Env): string | undefined {
  const flag = stringFlag(parsed, name);
  if (flag !== undefined) {
    return flag;
  }
  const value = env[`WF_${name.toUpperCase().replaceAll("-", "_")}`];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Reads an integer flag that must lie in `[min, max]`; `undefined` when it
 * was not given.
 */
export function integerOption(
  parsed: ParsedCommand,
  name: string,
  env: Env,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const text = flagOrEnv(parsed, name, env);
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    const range =
      max === Number.MAX_SAFE_INTEGER
        ? `at least ${String(min)}`
        : `${String(min)} to ${String(max)}`;
    throw new CliError(`--${name} must be a whole number ${range}`, 2);
  }
  return value;
}

/**
 * The runtime settings of a long running command.
 */
export interface RuntimeSettings {
  readonly poolSize: number | undefined;
  readonly logLevel: LogLevel;
  readonly logFormat: "json" | "text";
  readonly otlpEndpoint: string | undefined;
  readonly samplingRatio: number | undefined;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Reads `RUNTIME_OPTIONS`. Defaults: log level `info`, log format `json`.
 */
export function parseRuntimeSettings(parsed: ParsedCommand, env: Env): RuntimeSettings {
  const level = flagOrEnv(parsed, "log-level", env) ?? "info";
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new CliError(`--log-level must be one of ${LOG_LEVELS.join(", ")}`, 2);
  }
  const format = flagOrEnv(parsed, "log-format", env) ?? "json";
  if (format !== "json" && format !== "text") {
    throw new CliError("--log-format must be json or text", 2);
  }
  const ratioText = flagOrEnv(parsed, "sampling-ratio", env);
  const ratio = ratioText === undefined ? undefined : Number(ratioText);
  if (ratio !== undefined && !(ratio >= 0 && ratio <= 1)) {
    throw new CliError("--sampling-ratio must be a number from 0 to 1", 2);
  }
  return {
    poolSize: integerOption(parsed, "pool-size", env, 1, 1000),
    logLevel: level as LogLevel,
    logFormat: format,
    otlpEndpoint: flagOrEnv(parsed, "otlp-endpoint", env),
    samplingRatio: ratio,
  };
}

function textLine(line: string): string {
  const entry = JSON.parse(line) as Record<string, unknown>;
  const { time, level, message, ...rest } = entry;
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${String(time)} ${String(level).toUpperCase().padEnd(5)} ${String(message)}${fields === "" ? "" : ` ${fields}`}`;
}

/**
 * Builds the logger of a long running command. Every line, including the
 * startup lines, goes to stdout: one json object per line, or a plain text
 * line with `--log-format text`.
 */
export function createCliLogger(settings: RuntimeSettings, io: CliIo, fields = {}): Logger {
  return createLogger({
    level: settings.logLevel,
    fields,
    sink: (line) => {
      io.stdout(settings.logFormat === "json" ? line : textLine(line));
    },
  });
}

/**
 * Starts an OpenTelemetry provider for `serviceName` when an endpoint was
 * given; `undefined` otherwise.
 */
export function createCliTracing(
  settings: RuntimeSettings,
  serviceName: string,
): TracingProvider | undefined {
  if (settings.otlpEndpoint === undefined) {
    return undefined;
  }
  return createTracingProvider({
    serviceName,
    otlpEndpoint: settings.otlpEndpoint,
    ...(settings.samplingRatio === undefined ? {} : { samplingRatio: settings.samplingRatio }),
  });
}

/**
 * The limits `serve` applies, `undefined` for the ones not given.
 */
export interface ServeLimits {
  readonly quota: Partial<NamespaceQuota>;
  readonly maxQueueDepth: number | undefined;
  readonly metricsToken: string | undefined;
  readonly metricsCacheMs: number | undefined;
}

/**
 * Reads `QUOTA_OPTIONS`.
 */
export function parseServeLimits(parsed: ParsedCommand, env: Env): ServeLimits {
  const quota: { -readonly [K in keyof NamespaceQuota]?: number } = {};
  const runs = integerOption(parsed, "max-concurrent-runs", env, 1);
  const pending = integerOption(parsed, "max-pending-tasks", env, 1);
  const rate = integerOption(parsed, "rate-per-second", env, 1);
  const burst = integerOption(parsed, "burst", env, 1);
  if (runs !== undefined) quota.maxConcurrentRuns = runs;
  if (pending !== undefined) quota.maxPendingTasks = pending;
  if (rate !== undefined) quota.ratePerSecond = rate;
  if (burst !== undefined) quota.burst = burst;
  if (burst !== undefined && rate === undefined) {
    throw new CliError("--burst needs --rate-per-second", 2);
  }
  return {
    quota,
    maxQueueDepth: integerOption(parsed, "max-queue-depth", env, 1),
    metricsToken: flagOrEnv(parsed, "metrics-token", env),
    metricsCacheMs: integerOption(parsed, "metrics-cache-ms", env, 0),
  };
}

/**
 * The compactor schedule of a worker: it runs every `intervalSeconds` and
 * compacts runs closed for `retentionSeconds`, keeping `tailEvents`.
 */
export interface CompactionSettings {
  readonly intervalMs: number;
  readonly batchSize: number | undefined;
  readonly policy: RetentionPolicy;
}

const SECOND_MS = 1000;
const DEFAULT_RETENTION_SECONDS = 7 * 24 * 3600;
const DEFAULT_TAIL_EVENTS = 20;

/**
 * Reads `COMPACTION_OPTIONS`; `undefined` unless `--compact-interval` is given.
 */
export function parseCompactionSettings(
  parsed: ParsedCommand,
  env: Env,
): CompactionSettings | undefined {
  const interval = integerOption(parsed, "compact-interval", env, 1);
  if (interval === undefined) {
    for (const name of ["compact-retention", "compact-tail-events", "compact-batch"]) {
      if (flagOrEnv(parsed, name, env) !== undefined) {
        throw new CliError(`--${name} needs --compact-interval`, 2);
      }
    }
    return undefined;
  }
  return {
    intervalMs: interval * SECOND_MS,
    batchSize: integerOption(parsed, "compact-batch", env, 1, 10_000),
    policy: {
      closedRunRetentionMs:
        (integerOption(parsed, "compact-retention", env, 0) ?? DEFAULT_RETENTION_SECONDS) *
        SECOND_MS,
      tailEvents: integerOption(parsed, "compact-tail-events", env, 0) ?? DEFAULT_TAIL_EVENTS,
    },
  };
}

/**
 * Where a worker serves health and metrics.
 */
export interface OpsSettings {
  readonly port: number;
  readonly host: string;
  readonly metricsToken: string | undefined;
}

/**
 * Reads `OPS_OPTIONS`; `undefined` unless `--health-port` is given.
 */
export function parseOpsSettings(parsed: ParsedCommand, env: Env): OpsSettings | undefined {
  const port = integerOption(parsed, "health-port", env, 0, 65535);
  if (port === undefined) {
    return undefined;
  }
  return {
    port,
    host: flagOrEnv(parsed, "health-host", env) ?? "0.0.0.0",
    metricsToken: flagOrEnv(parsed, "metrics-token", env),
  };
}
