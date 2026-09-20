import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface TsconfigBase {
  compilerOptions: Record<string, unknown>;
}

const tsconfigBase = JSON.parse(
  readFileSync(new URL("../../tsconfig.base.json", import.meta.url), "utf8"),
) as TsconfigBase;

describe("tsconfig.base.json", () => {
  it("turns on strict mode and the extra strictness flags the quality bar requires", () => {
    const { compilerOptions } = tsconfigBase;

    expect(compilerOptions["strict"]).toBe(true);
    expect(compilerOptions["noImplicitAny"]).toBe(true);
    expect(compilerOptions["noUncheckedIndexedAccess"]).toBe(true);
    expect(compilerOptions["exactOptionalPropertyTypes"]).toBe(true);
  });
});
