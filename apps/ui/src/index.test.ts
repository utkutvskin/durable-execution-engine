import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@dee/ui package identity", () => {
  it("exposes its own package name", () => {
    expect(packageName).toBe("@dee/ui");
  });
});
