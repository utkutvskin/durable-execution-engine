import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface RootPackageJson {
  scripts: Record<string, string>;
}

const rootPackageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as RootPackageJson;

describe("root package.json", () => {
  it("runs lint, then typecheck, then test, in that order, from a single verify script", () => {
    const verify = rootPackageJson.scripts["verify"];
    expect(verify).toBeDefined();
    if (verify === undefined) {
      throw new Error("unreachable: asserted above");
    }

    const lintIndex = verify.indexOf("run lint");
    const typecheckIndex = verify.indexOf("run typecheck");
    const testIndex = verify.indexOf("run test");

    expect(lintIndex).toBeGreaterThanOrEqual(0);
    expect(typecheckIndex).toBeGreaterThan(lintIndex);
    expect(testIndex).toBeGreaterThan(typecheckIndex);
  });
});
