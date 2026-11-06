import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Severity of a log line, lowest first.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Fields attached to a log line.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Writes structured json log lines. Every line carries `time`, `level`,
 * `message`, the logger's bound fields, the call's fields and, inside
 * `withCorrelationId`, the `correlationId`. Bound and call fields cannot
 * replace those four core fields: the core value always wins.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger whose lines also carry `fields`. */
  child(fields: LogFields): Logger;
}

/**
 * Options for `createLogger`. `sink` receives one serialized line per call
 * (default: stdout), `level` is the minimum level written (default `info`).
 */
export interface LoggerOptions {
  /**
   * Called for every key and value inside a line's fields, at any depth,
   * and returns the value to write. Use it to mask secrets. It is not
   * called for `time`, `level`, `message` or `correlationId`.
   */
  readonly redact?: (key: string, value: unknown) => unknown;
  readonly sink?: (line: string) => void;
  readonly level?: LogLevel;
  readonly clock?: { now(): Date };
  readonly fields?: LogFields;
}

const CORE_FIELDS: ReadonlySet<string> = new Set(["time", "level", "message", "correlationId"]);
const PROTECTED_FIELDS: ReadonlySet<string> = new Set(["time", "level", "message"]);

const correlationStorage = new AsyncLocalStorage<string>();

/**
 * Runs `callback` with `correlationId` attached to every log line written
 * inside it, across awaits.
 */
export function withCorrelationId<T>(correlationId: string, callback: () => T): T {
  return correlationStorage.run(correlationId, callback);
}

/**
 * The correlation id of the running call chain, if any.
 */
export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

/**
 * Returns `candidate` when it is a usable correlation id (1 to 128 characters
 * of letters, digits and `-_.:`), otherwise a new uuid.
 */
export function resolveCorrelationId(candidate: string | null | undefined): string {
  if (candidate !== null && candidate !== undefined && /^[\w.:-]{1,128}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

function serializeError(error: Error): Record<string, unknown> {
  return { name: error.name, message: error.message, stack: error.stack };
}

function makeReplacer(
  redact: ((key: string, value: unknown) => unknown) | undefined,
  entry: object,
): (this: unknown, key: string, value: unknown) => unknown {
  return function replacer(this: unknown, key: string, value: unknown): unknown {
    const redacted =
      redact === undefined || (this === entry && CORE_FIELDS.has(key)) || key === ""
        ? value
        : redact(key, value);
    if (redacted instanceof Error) {
      return serializeError(redacted);
    }
    if (typeof redacted === "bigint") {
      return redacted.toString();
    }
    return redacted;
  };
}

/**
 * Creates a `Logger`.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const clock = options.clock ?? { now: () => new Date() };

  function build(bound: LogFields): Logger {
    function write(level: LogLevel, message: string, fields: LogFields = {}): void {
      if (LEVEL_ORDER[level] < threshold) {
        return;
      }
      const correlationId = currentCorrelationId();
      const extras = Object.fromEntries(
        Object.entries({ ...bound, ...fields }).filter(
          ([key]) => !PROTECTED_FIELDS.has(key) && !(key === "correlationId" && correlationId),
        ),
      );
      const entry = {
        time: clock.now().toISOString(),
        level,
        message,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...extras,
      };
      sink(JSON.stringify(entry, makeReplacer(options.redact, entry)));
    }
    return {
      debug: (message, fields) => {
        write("debug", message, fields);
      },
      info: (message, fields) => {
        write("info", message, fields);
      },
      warn: (message, fields) => {
        write("warn", message, fields);
      },
      error: (message, fields) => {
        write("error", message, fields);
      },
      child: (fields) => build({ ...bound, ...fields }),
    };
  }

  return build(options.fields ?? {});
}

/**
 * A logger that drops every line.
 */
export const silentLogger: Logger = createLogger({ sink: () => undefined });
