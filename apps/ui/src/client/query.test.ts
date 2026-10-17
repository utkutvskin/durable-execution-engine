import { describe, expect, it } from "vitest";
import { formatOffset, formatTimestamp } from "./format.js";
import { buildListQuery } from "./query.js";

const none = { status: "", workflowType: "", from: "", to: "" };

describe("buildListQuery", () => {
  it("sends only the limit when no filter is set", () => {
    expect(buildListQuery(none, 25).toString()).toBe("limit=25");
  });

  it("sends status, trimmed workflow type and the cursor", () => {
    const query = buildListQuery(
      { ...none, status: "RUNNING", workflowType: " order " },
      10,
      "abc",
    );
    expect(query.get("status")).toBe("RUNNING");
    expect(query.get("workflowType")).toBe("order");
    expect(query.get("cursor")).toBe("abc");
  });

  it("turns the to date into an exclusive bound at the start of the next day", () => {
    const query = buildListQuery({ ...none, from: "2026-03-01", to: "2026-03-01" }, 5);
    expect(query.get("startedAfter")).toBe("2026-03-01T00:00:00.000Z");
    expect(query.get("startedBefore")).toBe("2026-03-02T00:00:00.000Z");
  });

  it("drops dates that are malformed or impossible", () => {
    const query = buildListQuery({ ...none, from: "03/01/2026", to: "2026-13-45" }, 5);
    expect(query.has("startedAfter")).toBe(false);
    expect(query.has("startedBefore")).toBe(false);
  });
});

describe("format helpers", () => {
  it("renders offsets in ms, seconds and minutes", () => {
    expect(formatOffset(0)).toBe("+0 ms");
    expect(formatOffset(1500)).toBe("+1.5 s");
    expect(formatOffset(90_000)).toBe("+1.5 min");
  });

  it("renders a timestamp without the t, the fraction and the zone", () => {
    expect(formatTimestamp("2026-03-01T10:00:01.250Z")).toBe("2026-03-01 10:00:01");
  });
});
