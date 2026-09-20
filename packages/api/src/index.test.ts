import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@dee/api package identity", () => {
  it("exposes its own package name", () => {
    expect(packageName).toBe("@dee/api");
  });
});
