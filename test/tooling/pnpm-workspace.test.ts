import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8");

describe("pnpm-workspace.yaml", () => {
  it.each(["packages/*", "apps/*", "examples/*"])("includes the %s workspace glob", (glob) => {
    expect(workspaceSource).toContain(glob);
  });
});
