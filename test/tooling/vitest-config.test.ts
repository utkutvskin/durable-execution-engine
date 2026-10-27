import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";

describe("vitest.config.ts", () => {
  it("sets a test and a hook timeout above the polling helpers", () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(30_000);
    expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(config.test?.testTimeout ?? 0);
  });
});
