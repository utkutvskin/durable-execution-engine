import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import {
  COMPACTION_OPTIONS,
  OPS_OPTIONS,
  QUOTA_OPTIONS,
  RUNTIME_OPTIONS,
  createCliLogger,
  flagOrEnv,
  integerOption,
  parseCompactionSettings,
  parseOpsSettings,
  parseRuntimeSettings,
  parseServeLimits,
} from "./runtime-flags.js";
import { parseCommand } from "./shared.js";

const ALL = { ...RUNTIME_OPTIONS, ...QUOTA_OPTIONS, ...COMPACTION_OPTIONS, ...OPS_OPTIONS };

function parse(...args: string[]) {
  return parseCommand(args, ALL);
}

describe("runtime flags", () => {
  it("prefers a flag over its WF_ environment variable", () => {
    expect(flagOrEnv(parse("--pool-size", "5"), "pool-size", { WF_POOL_SIZE: "9" })).toBe("5");
    expect(flagOrEnv(parse(), "pool-size", { WF_POOL_SIZE: "9" })).toBe("9");
    expect(flagOrEnv(parse(), "pool-size", { WF_POOL_SIZE: "" })).toBeUndefined();
  });

  it("accepts only whole numbers inside the range", () => {
    expect(integerOption(parse("--pool-size", "12"), "pool-size", {}, 1, 20)).toBe(12);
    for (const bad of ["0", "21", "1.5", "-3", "abc", "1e3"]) {
      expect(() => integerOption(parse("--pool-size", bad), "pool-size", {}, 1, 20), bad).toThrow(
        CliError,
      );
    }
  });

  it("defaults to info level and json format", () => {
    expect(parseRuntimeSettings(parse(), {})).toEqual({
      poolSize: undefined,
      logLevel: "info",
      logFormat: "json",
      otlpEndpoint: undefined,
      samplingRatio: undefined,
    });
  });

  it("reads level, format, endpoint and sampling from flags", () => {
    const settings = parseRuntimeSettings(
      parse(
        "--log-level",
        "debug",
        "--log-format",
        "text",
        "--otlp-endpoint",
        "http://jaeger:4318/v1/traces",
        "--sampling-ratio",
        "0.25",
      ),
      {},
    );
    expect(settings).toMatchObject({
      logLevel: "debug",
      logFormat: "text",
      otlpEndpoint: "http://jaeger:4318/v1/traces",
      samplingRatio: 0.25,
    });
  });

  it("writes json lines, honours the level and keeps the service field", () => {
    const lines: string[] = [];
    const io = {
      stdout: (line: string) => lines.push(line),
      stderr: () => undefined,
      env: {},
      cwd: ".",
    };
    const logger = createCliLogger(parseRuntimeSettings(parse("--log-level", "warn"), {}), io, {
      service: "wf-test",
    });
    logger.info("hidden");
    logger.warn("shown", { code: 7 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "warn",
      message: "shown",
      code: 7,
      service: "wf-test",
    });
  });

  it("collects only the quota flags that were given", () => {
    const limits = parseServeLimits(
      parse("--max-concurrent-runs", "3", "--rate-per-second", "10", "--max-queue-depth", "500"),
      {},
    );
    expect(limits.quota).toEqual({ maxConcurrentRuns: 3, ratePerSecond: 10 });
    expect(limits.maxQueueDepth).toBe(500);
    expect(parseServeLimits(parse(), {}).quota).toEqual({});
  });

  it("turns the compaction flags into milliseconds with a week of retention by default", () => {
    expect(parseCompactionSettings(parse(), {})).toBeUndefined();
    expect(parseCompactionSettings(parse("--compact-interval", "30"), {})).toEqual({
      intervalMs: 30_000,
      batchSize: undefined,
      policy: { closedRunRetentionMs: 604_800_000, tailEvents: 20 },
    });
  });

  it("serves health only when a port is given and listens on all addresses by default", () => {
    expect(parseOpsSettings(parse(), {})).toBeUndefined();
    expect(parseOpsSettings(parse("--health-port", "9100"), {})).toEqual({
      port: 9100,
      host: "0.0.0.0",
      metricsToken: undefined,
    });
  });
});
