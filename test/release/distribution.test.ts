import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

const PACKAGES = [
  "packages/core",
  "packages/worker",
  "packages/api",
  "apps/ui",
  "examples/hello",
  "examples/payment-saga",
  "examples/etl-pipeline",
  "packages/cli",
] as const;

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${root}${relative}`, "utf8")) as Record<string, unknown>;
}

function readText(relative: string): string {
  return readFileSync(`${root}${relative}`, "utf8");
}

describe("the built distribution", () => {
  it.each(PACKAGES)("%s maps development to src and everything else to dist", (directory) => {
    const manifest = readJson(`${directory}/package.json`);
    expect(manifest["private"]).toBeUndefined();
    expect(manifest["exports"]).toEqual({
      ".": {
        development: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./package.json": "./package.json",
    });
  });

  it.each(PACKAGES)(
    "%s publishes an exports map without the development condition",
    (directory) => {
      const manifest = readJson(`${directory}/package.json`);
      const publishConfig = manifest["publishConfig"] as Record<string, unknown>;
      expect(JSON.stringify(publishConfig["exports"])).not.toContain("development");
      expect(JSON.stringify(publishConfig["exports"])).not.toContain("/src/");
      expect(publishConfig["access"]).toBe("public");
    },
  );

  it.each(PACKAGES)("%s ships dist, LICENSE and NOTICE identical to the root ones", (directory) => {
    const manifest = readJson(`${directory}/package.json`);
    expect(manifest["files"]).toEqual(expect.arrayContaining(["dist", "LICENSE", "NOTICE"]));
    expect(readText(`${directory}/LICENSE`)).toBe(readText("LICENSE"));
    expect(readText(`${directory}/NOTICE`)).toBe(readText("NOTICE"));
    expect(manifest["license"]).toBe("Apache-2.0");
  });

  it("ships the migrations with core and the browser modules with the ui", () => {
    expect(readJson("packages/core/package.json")["files"]).toContain("migrations");
    expect(readJson("apps/ui/package.json")["files"]).toContain("src/client");
  });

  it("builds every package in one root build with project references", () => {
    const build = readJson("tsconfig.build.json") as { references: { path: string }[] };
    expect(build.references.map((entry) => entry.path)).toEqual(
      PACKAGES.map((directory) => `./${directory}/tsconfig.build.json`),
    );
    for (const directory of PACKAGES) {
      expect(existsSync(`${root}${directory}/tsconfig.build.json`)).toBe(true);
    }
  });

  it("keeps the @dee mapping in the exports maps only", () => {
    const configs = ["tsconfig.json", ...PACKAGES.map((directory) => `${directory}/tsconfig.json`)];
    for (const config of configs) {
      expect(readText(config)).not.toContain('"paths"');
    }
    expect(readText("vitest.config.ts")).not.toContain("alias");
    expect(existsSync(`${root}packages/cli/src/runtime/resolve-hooks.ts`)).toBe(false);
    expect(existsSync(`${root}packages/worker/src/chaos/resolve-hooks.ts`)).toBe(false);
  });

  it("compiles with the development condition and rewritten import extensions", () => {
    const base = readText("tsconfig.base.json");
    expect(base).toContain('"customConditions": ["development"]');
    expect(base).toContain('"rewriteRelativeImportExtensions": true');
  });

  it("builds the declarations against the published conditions, not the development one", () => {
    const build = readJson("packages/cli/tsconfig.build.json") as {
      compilerOptions: Record<string, unknown>;
    };
    expect(build.compilerOptions["customConditions"]).toEqual([]);
    expect(build.compilerOptions["outDir"]).toBe("dist");
  });

  it("runs the built cli when dist exists and falls back to the sources otherwise", () => {
    const bin = readText("packages/cli/bin/wf.js");
    expect(bin).toContain("../dist/main.js");
    expect(bin).toContain("--conditions=development");
    expect(bin).not.toContain("register(");
  });
});

describe("the ci job for the packed packages", () => {
  const ci = readText(".github/workflows/ci.yml");

  it("packs, lints and installs the tarballs in a clean node 22 container", () => {
    expect(ci).toContain("node scripts/pack-packages.mjs .packed");
    expect(ci).toContain("node scripts/check-packages.mjs .packed");
    expect(ci).toMatch(/docker run[\s\S]*node:22 sh \/smoke-install\.sh/);
  });

  it("checks the packages with publint and attw", () => {
    const check = readText("scripts/check-packages.mjs");
    expect(check).toContain("publint");
    expect(check).toContain("attw");
    expect(check).toContain("package/LICENSE");
    expect(check).toContain("package/NOTICE");
  });

  it("starts wf dev from the installed packages and waits for the hello run", () => {
    const smoke = readText("scripts/smoke-install.sh");
    expect(smoke).toContain("npm install");
    expect(smoke).toContain("wf dev --module node_modules/@dee/example-hello/dist/index.js");
    expect(smoke).toContain("wf run start hello");
  });
});
