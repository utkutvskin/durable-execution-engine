import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

describe("Dockerfile", () => {
  it("hands the app directory itself to the node user, so wf dev can create .wf in it", () => {
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    const chown = runtime.indexOf("RUN chown node:node /app");
    expect(chown).toBeGreaterThan(-1);
    expect(chown).toBeLessThan(runtime.indexOf("USER node"));
  });
});
