import { describe, expect, it } from "vitest";
import { DEFAULT_CHROMIUM_PATH, planBrowser } from "./browser.js";

describe("planBrowser", () => {
  it("runs the test when the default browser exists", () => {
    expect(planBrowser({ env: {}, exists: () => true })).toEqual({
      mode: "run",
      path: DEFAULT_CHROMIUM_PATH,
    });
  });

  it("prefers the path from PLAYWRIGHT_CHROMIUM_PATH", () => {
    const plan = planBrowser({
      env: { PLAYWRIGHT_CHROMIUM_PATH: "/custom/chrome" },
      exists: (candidate) => candidate === "/custom/chrome",
    });
    expect(plan).toEqual({ mode: "run", path: "/custom/chrome" });
  });

  it("skips locally with a message that names the variable", () => {
    const plan = planBrowser({ env: {}, exists: () => false });
    expect(plan.mode).toBe("skip");
    expect("message" in plan && plan.message).toContain("PLAYWRIGHT_CHROMIUM_PATH");
  });

  it("fails in CI instead of skipping when the browser is missing", () => {
    expect(planBrowser({ env: { CI: "true" }, exists: () => false }).mode).toBe("fail");
  });

  it("treats any other CI value as a local run", () => {
    expect(planBrowser({ env: { CI: "false" }, exists: () => false }).mode).toBe("skip");
  });
});
