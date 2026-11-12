import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkApiReport, reportFileName } from "../../scripts/api-report-lib.mjs";
import { PACKAGE_DIRECTORIES } from "../../scripts/package-directories.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

describe("api reports", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "api-report-"));
    await mkdir(path.join(directory, "package", "dist"), { recursive: true });
    await writeFile(
      path.join(directory, "package", "package.json"),
      JSON.stringify({ name: "@dee/probe", version: "0.0.0", types: "dist/index.d.ts" }),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function declare(source: string): Promise<void> {
    await writeFile(path.join(directory, "package", "dist", "index.d.ts"), source);
  }

  function check(update: boolean) {
    return checkApiReport(path.join(directory, "package"), {
      reportFolder: path.join(directory, "reports"),
      tempFolder: path.join(directory, "temp"),
      update,
    });
  }

  it("names a report after the package", () => {
    expect(reportFileName("@dee/core")).toBe("dee-core.api.md");
    expect(reportFileName("@dee/example-hello")).toBe("dee-example-hello.api.md");
  });

  it("keeps a committed report for every published package", () => {
    for (const packageDirectory of PACKAGE_DIRECTORIES) {
      const manifest = JSON.parse(
        readFileSync(path.join(root, packageDirectory, "package.json"), "utf8"),
      ) as { name: string };
      expect(existsSync(path.join(root, "api-reports", reportFileName(manifest.name)))).toBe(true);
    }
  });

  it("passes unchanged declarations and fails an added export until the report is updated", async () => {
    await declare("/** a */\nexport declare function a(): number;\n");
    await mkdir(path.join(directory, "reports"));
    expect(check(true)).toMatchObject({ ok: true, name: "@dee/probe" });
    expect(check(false)).toMatchObject({ ok: true, changed: false });

    await declare(
      "/** a */\nexport declare function a(): number;\n/** b */\nexport declare const b: string;\n",
    );
    expect(check(false)).toMatchObject({ ok: false, changed: true });
    expect(check(true)).toMatchObject({ ok: true, changed: true });
    expect(await readFile(path.join(directory, "reports", "dee-probe.api.md"), "utf8")).toContain(
      "export const b: string;",
    );
    expect(check(false)).toMatchObject({ ok: true, changed: false });
  });

  it("fails a changed signature and a removed export", async () => {
    await declare(
      "/** a */\nexport declare function a(): number;\n/** c */\nexport declare const c = 1;\n",
    );
    await mkdir(path.join(directory, "reports"));
    check(true);
    await declare(
      "/** a */\nexport declare function a(value: string): number;\n/** c */\nexport declare const c = 1;\n",
    );
    expect(check(false)).toMatchObject({ ok: false, changed: true });
    await declare("/** a */\nexport declare function a(): number;\n");
    expect(check(false)).toMatchObject({ ok: false, changed: true });
  });

  it("runs in the packages job of ci after the build", () => {
    const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("  packages:"), ci.indexOf("  docker:"));
    expect(job.indexOf("run: node scripts/api-report.mjs")).toBeGreaterThan(
      job.indexOf("run: pnpm run build"),
    );
  });
});
