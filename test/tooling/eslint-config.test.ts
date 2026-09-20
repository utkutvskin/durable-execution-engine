import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const eslintConfigSource = readFileSync(new URL("../../eslint.config.js", import.meta.url), "utf8");

describe("eslint.config.js", () => {
  it("forbids @typescript-eslint/no-explicit-any as an error", () => {
    expect(eslintConfigSource).toMatch(/"@typescript-eslint\/no-explicit-any":\s*"error"/);
  });

  it("applies eslint-config-prettier last, so eslint never fights prettier on formatting", () => {
    const importLine = /import eslintConfigPrettier from "eslint-config-prettier";/;
    const lastArrayEntry = /eslintConfigPrettier,\s*\);\s*$/m;

    expect(eslintConfigSource).toMatch(importLine);
    expect(eslintConfigSource).toMatch(lastArrayEntry);
  });
});
