import { describe, expect, it } from "vitest";
import { describePause, utcInstant } from "./schedules-view.js";

describe("schedules view helpers", () => {
  it("reads a datetime-local value as a utc instant and refuses an empty or bad one", () => {
    expect(utcInstant("2026-02-27T00:00")).toBe("2026-02-27T00:00:00.000Z");
    expect(utcInstant("2026-02-27T05:30:00+02:00")).toBe("2026-02-27T03:30:00.000Z");
    expect(utcInstant("  ")).toBeUndefined();
    expect(utcInstant("yesterday")).toBeUndefined();
  });

  it("describes what each kind of pause holds back", () => {
    const base = { reason: null, pausedAt: "2026-03-01T10:00:00.000Z" };
    expect(describePause({ ...base, scope: "run", runId: "r-1", queueName: null })).toBe("run r-1");
    expect(describePause({ ...base, scope: "queue", runId: null, queueName: "default" })).toBe(
      "queue default",
    );
    expect(describePause({ ...base, scope: "namespace", runId: null, queueName: null })).toBe(
      "the whole namespace",
    );
  });
});
