import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertVersionMatchesTag,
  extractReleaseNotes,
  parseTag,
  planRelease,
  publishCommands,
  tarballName,
} from "../../scripts/release-lib.mjs";
import { PACKAGE_DIRECTORIES } from "../../scripts/package-directories.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

function read(relative: string): string {
  return readFileSync(`${root}${relative}`, "utf8");
}

function manifestOf(directory: string): { name: string; version: string } {
  return JSON.parse(read(`${directory}/package.json`)) as { name: string; version: string };
}

const CHANGELOG = [
  "# Changelog",
  "",
  "## [0.2.0] - 2026-12-01",
  "",
  "Second release.",
  "",
  "### Added",
  "",
  "- a thing",
  "",
  "## [0.1.1] - 2026-11-08",
  "",
  "A patch release.",
  "",
].join("\n");

describe("release tags", () => {
  it("parses a plain tag as a release that publishes to latest", () => {
    expect(parseTag("v0.2.0")).toEqual({
      tag: "v0.2.0",
      version: "0.2.0",
      base: "0.2.0",
      prerelease: false,
      npmTag: "latest",
    });
  });

  it("parses a suffixed tag as a pre-release that publishes to next", () => {
    expect(parseTag("v0.2.0-rc.1")).toMatchObject({
      version: "0.2.0-rc.1",
      base: "0.2.0",
      prerelease: true,
      npmTag: "next",
    });
  });

  it.each(["0.2.0", "v0.2", "v0.2.0.1", "vx.y.z", "v0.2.0-", "release-1"])(
    "rejects %s as a release tag",
    (tag) => {
      expect(() => parseTag(tag)).toThrow("is not a release tag");
    },
  );

  it("accepts the base version for a pre-release tag and nothing else", () => {
    expect(() => {
      assertVersionMatchesTag("v0.2.0-rc.1", "0.2.0");
    }).not.toThrow();
    expect(() => {
      assertVersionMatchesTag("v0.2.0-rc.1", "0.2.0-rc.1");
    }).not.toThrow();
    expect(() => {
      assertVersionMatchesTag("v0.2.0-rc.1", "0.1.1");
    }).toThrow("does not match tag");
  });

  it("requires the exact version for a release tag", () => {
    expect(() => {
      assertVersionMatchesTag("v0.2.0", "0.2.0");
    }).not.toThrow();
    expect(() => {
      assertVersionMatchesTag("v0.2.0", "0.1.1");
    }).toThrow("does not match tag v0.2.0");
  });
});

describe("release plan", () => {
  it("releases for real on a pushed plain tag", () => {
    expect(planRelease({ eventName: "push", refName: "v0.2.0" })).toEqual({
      tag: "v0.2.0",
      version: "0.2.0",
      npmTag: "latest",
      dryRun: false,
    });
  });

  it("makes a pushed pre-release tag a dry run", () => {
    expect(planRelease({ eventName: "push", refName: "v0.2.0-rc.1" }).dryRun).toBe(true);
  });

  it("makes a manual run a dry run and refuses a plain tag for it", () => {
    expect(
      planRelease({ eventName: "workflow_dispatch", refName: "main", inputTag: "v0.1.1-rc.1" }),
    ).toMatchObject({ tag: "v0.1.1-rc.1", dryRun: true });
    expect(() =>
      planRelease({ eventName: "workflow_dispatch", refName: "main", inputTag: "v0.1.1" }),
    ).toThrow("needs a pre-release tag");
    expect(() => planRelease({ eventName: "workflow_dispatch", refName: "main" })).toThrow(
      "no tag to release",
    );
  });
});

describe("release notes", () => {
  it("cuts the section of the tag out of the changelog", () => {
    expect(extractReleaseNotes(CHANGELOG, "v0.2.0")).toBe(
      "Second release.\n\n### Added\n\n- a thing\n",
    );
    expect(extractReleaseNotes(CHANGELOG, "v0.1.1")).toBe("A patch release.\n");
  });

  it("falls back to the base version for a pre-release tag", () => {
    expect(extractReleaseNotes(CHANGELOG, "v0.2.0-rc.2")).toBe(
      extractReleaseNotes(CHANGELOG, "v0.2.0"),
    );
  });

  it("fails when the changelog has no section for the tag", () => {
    expect(() => extractReleaseNotes(CHANGELOG, "v0.3.0")).toThrow("no section for 0.3.0");
  });

  it("finds a section in the real changelog for the current version", () => {
    const { version } = manifestOf("packages/core");
    expect(extractReleaseNotes(read("CHANGELOG.md"), `v${version}`).length).toBeGreaterThan(20);
  });
});

describe("publishing", () => {
  it("publishes every tarball with provenance, public access and the npm tag of the release", () => {
    const commands = publishCommands({
      tarballs: ["a.tgz", "b.tgz"],
      tag: "v0.2.0",
      dryRun: false,
    });
    expect(commands).toEqual([
      ["publish", "a.tgz", "--access", "public", "--provenance", "--tag", "latest"],
      ["publish", "b.tgz", "--access", "public", "--provenance", "--tag", "latest"],
    ]);
  });

  it("adds --dry-run and the next tag for a pre-release dry run", () => {
    const [command] = publishCommands({ tarballs: ["a.tgz"], tag: "v0.2.0-rc.1", dryRun: true });
    expect(command).toEqual([
      "publish",
      "a.tgz",
      "--access",
      "public",
      "--provenance",
      "--tag",
      "next",
      "--dry-run",
    ]);
  });

  it("names tarballs the way pnpm pack does", () => {
    expect(tarballName({ name: "@dee/example-hello", version: "0.1.1" })).toBe(
      "dee-example-hello-0.1.1.tgz",
    );
  });

  it("lists the publishable packages in dependency order", () => {
    const names = PACKAGE_DIRECTORIES.map((directory) => manifestOf(directory).name);
    const dependencies = new Map(
      PACKAGE_DIRECTORIES.map((directory) => [
        manifestOf(directory).name,
        Object.keys(
          (JSON.parse(read(`${directory}/package.json`)) as { dependencies?: object })
            .dependencies ?? {},
        ),
      ]),
    );
    names.forEach((name, index) => {
      for (const dependency of dependencies.get(name) ?? []) {
        if (names.includes(dependency)) {
          expect(names.indexOf(dependency)).toBeLessThan(index);
        }
      }
    });
  });
});

describe("changesets", () => {
  const config = JSON.parse(read(".changeset/config.json")) as {
    fixed: string[][];
    access: string;
    baseBranch: string;
  };

  it("puts every published package in one fixed version group", () => {
    const published = PACKAGE_DIRECTORIES.map((directory) => manifestOf(directory).name).sort();
    expect(config.fixed).toHaveLength(1);
    expect([...(config.fixed[0] ?? [])].sort()).toEqual(published);
  });

  it("keeps the packages at one version and publishes publicly from main", () => {
    const versions = new Set(PACKAGE_DIRECTORIES.map((directory) => manifestOf(directory).version));
    expect(versions.size).toBe(1);
    expect(config.access).toBe("public");
    expect(config.baseBranch).toBe("main");
  });
});

describe(".github/workflows/release.yml", () => {
  const workflow = read(".github/workflows/release.yml");

  it("runs on a pushed version tag and can be started by hand for a dry run", () => {
    expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\["v\*"\]/);
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("runs verify before it publishes or pushes anything", () => {
    expect(workflow).toContain("run: pnpm run verify");
    expect(workflow).toMatch(/npm:\s*\n\s*needs: \[plan, verify\]/);
    expect(workflow).toMatch(/image:\s*\n\s*needs: \[plan, verify\]/);
    expect(workflow).toMatch(/github-release:\s*\n\s*needs: \[plan, npm, image\]/);
  });

  it("publishes with an identity token and no stored npm token", () => {
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("scripts/publish-packages.mjs");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("builds the image for both architectures with an sbom and provenance, and pushes only outside a dry run", () => {
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("push: ${{ needs.plan.outputs.dry_run != 'true' }}");
    expect(workflow).toMatch(
      /if: needs\.plan\.outputs\.dry_run != 'true'\s*\n\s*uses: docker\/login-action/,
    );
    expect(workflow).toContain("type=semver,pattern={{major}}.{{minor}}");
  });

  it("creates the github release from the changelog, as a draft in a dry run", () => {
    expect(workflow).toContain('node scripts/release-notes.mjs "$TAG"');
    expect(workflow).toContain("--notes-file release-notes.md");
    expect(workflow).toContain("--draft --prerelease");
  });
});

describe("the image", () => {
  const dockerfile = read("Dockerfile");

  it("compiles the packages and runs the compiled output, not the sources", () => {
    expect(dockerfile).toContain("pnpm run build");
    expect(dockerfile.indexOf("pnpm run build")).toBeLessThan(dockerfile.indexOf("--prod"));
    expect(dockerfile).not.toContain("--conditions=development");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "packages/cli/bin/wf.js"]');
  });

  it("is checked in the release workflow and in ci for the built entry point", () => {
    expect(read(".github/workflows/release.yml")).toContain("test -f packages/cli/dist/main.js");
    expect(read(".github/workflows/ci.yml")).toContain("test -f packages/cli/dist/main.js");
  });
});

describe("docs/RELEASING.md", () => {
  it("exists and lists the one-time owner steps", () => {
    expect(existsSync(`${root}docs/RELEASING.md`)).toBe(true);
    const releasing = read("docs/RELEASING.md");
    for (const heading of ["npm scope", "Trusted publisher", "GHCR", "dry run"]) {
      expect(releasing).toContain(heading);
    }
  });
});
