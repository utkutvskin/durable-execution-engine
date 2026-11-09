import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@dee/ui package identity", () => {
  it("exposes its own package name", () => {
    expect(packageName).toBe("@dee/ui");
  });
});
