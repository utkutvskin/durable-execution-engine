import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@dee/cli package identity", () => {
  it("exposes its own package name", () => {
    expect(packageName).toBe("@dee/cli");
  });
});
