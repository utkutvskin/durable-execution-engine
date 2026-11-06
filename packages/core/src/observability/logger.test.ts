import { describe, expect, it } from "vitest";
import { createLogger, resolveCorrelationId, withCorrelationId } from "./logger.js";

function capture(level?: "debug" | "info" | "warn" | "error") {
  const lines: (Record<string, unknown> & Line)[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown> & Line),
    clock: { now: () => new Date("2026-03-01T10:00:00.000Z") },
    ...(level === undefined ? {} : { level }),
  });
  return { lines, logger };
}

interface Line {
  readonly message?: unknown;
  readonly correlationId?: unknown;
  readonly error?: unknown;
}

describe("structured logger", () => {
  it("writes one json object per line with time, level and message", () => {
    const { lines, logger } = capture();
    logger.info("run started", { runId: "r1" });
    expect(lines).toEqual([
      { time: "2026-03-01T10:00:00.000Z", level: "info", message: "run started", runId: "r1" },
    ]);
  });

  it("drops lines below the configured level", () => {
    const { lines, logger } = capture("warn");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines.map((line) => line.message)).toEqual(["c", "d"]);
  });

  it("merges child fields and lets call fields win", () => {
    const { lines, logger } = capture();
    logger.child({ component: "worker", attempt: 1 }).info("tick", { attempt: 2 });
    expect(lines[0]).toMatchObject({ component: "worker", attempt: 2 });
  });

  it("attaches the correlation id across awaits and not outside", async () => {
    const { lines, logger } = capture();
    await withCorrelationId("corr-1", async () => {
      logger.info("before");
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      logger.info("after");
    });
    logger.info("outside");
    expect(lines.map((line) => line.correlationId)).toEqual(["corr-1", "corr-1", undefined]);
  });

  it("keeps concurrent correlation ids apart", async () => {
    const { lines, logger } = capture();
    await Promise.all(
      ["a", "b", "c"].map((id) =>
        withCorrelationId(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
          logger.info(id);
        }),
      ),
    );
    for (const line of lines) {
      expect(line.correlationId).toBe(line.message);
    }
  });

  it("serializes errors with name, message and stack", () => {
    const { lines, logger } = capture();
    logger.error("failed", { error: new RangeError("too big") });
    expect(lines[0]?.error).toMatchObject({ name: "RangeError", message: "too big" });
  });

  it("accepts a well-formed correlation id and replaces anything else", () => {
    expect(resolveCorrelationId("req-42.a:b")).toBe("req-42.a:b");
    expect(resolveCorrelationId("has space")).not.toBe("has space");
    expect(resolveCorrelationId("x".repeat(200))).toHaveLength(36);
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("does not let bound or call fields replace time, level or message", () => {
    const { lines, logger } = capture();
    logger
      .child({ level: "debug", time: "bound" })
      .info("real message", { message: "spoofed", level: "error", time: "yesterday", kept: 1 });
    expect(lines).toEqual([
      { time: "2026-03-01T10:00:00.000Z", level: "info", message: "real message", kept: 1 },
    ]);
  });

  it("does not let a field replace the correlation id of the running call chain", () => {
    const { lines, logger } = capture();
    withCorrelationId("real-id", () => {
      logger.info("inside", { correlationId: "spoofed" });
    });
    expect(lines[0]?.correlationId).toBe("real-id");
  });

  it("passes nested fields through the redaction hook and leaves core fields alone", () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      clock: { now: () => new Date("2026-03-01T10:00:00.000Z") },
      redact: (key, value) => (key === "password" || key === "message" ? "[masked]" : value),
    });
    logger.info("login", { user: "ada", request: { password: "hunter2", path: "/x" } });
    expect(lines).toEqual([
      {
        time: "2026-03-01T10:00:00.000Z",
        level: "info",
        message: "login",
        user: "ada",
        request: { password: "[masked]", path: "/x" },
      },
    ]);
  });
});
