import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../../packages/cli/src/main.js";
import { workflows } from "../../examples/hello/src/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function workspaceManifests(): string[] {
  const manifests = ["package.json"];
  for (const group of ["packages", "apps", "examples"]) {
    for (const entry of readdirSync(path.join(root, group), { withFileTypes: true })) {
      const manifest = path.join(group, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(path.join(root, manifest))) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
}

function latestChangelogVersion(): string {
  const match = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/m.exec(read("CHANGELOG.md"));
  if (match?.[1] === undefined) {
    throw new Error("CHANGELOG.md has no released version heading");
  }
  return match[1];
}

const DOCUMENTS = [
  "README.md",
  "CHANGELOG.md",
  "docs/ARCHITECTURE.md",
  "docs/CONCEPTS.md",
  "docs/DEPLOYMENT.md",
  "docs/ROADMAP.md",
  "docs/API.md",
  "docs/CLI.md",
  "docs/EXAMPLES.md",
];

describe("release 0.1.0", () => {
  it("gives every workspace package the version of the latest changelog entry", () => {
    const version = latestChangelogVersion();
    const versions = workspaceManifests().map((manifest) => ({
      manifest,
      version: (JSON.parse(read(manifest)) as { version: string }).version,
    }));
    expect(versions.length).toBeGreaterThanOrEqual(8);
    expect(versions.filter((entry) => entry.version !== version)).toEqual([]);
    expect(version).toBe("0.1.0");
  });

  it("links the changelog entry to the release tag", () => {
    expect(read("CHANGELOG.md")).toContain(
      "[0.1.0]: https://github.com/utkutvskin/durable-execution-engine/releases/tag/v0.1.0",
    );
  });

  it("builds the image in three stages and runs it as an unprivileged user", () => {
    const dockerfile = read("Dockerfile");
    const stages = [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map((match) => match[2]);
    expect(stages).toEqual(["base", "build", "runtime"]);
    expect(dockerfile).toMatch(/^FROM node:22-slim AS base$/m);
    expect(dockerfile).toContain("pnpm install --frozen-lockfile --prod");
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain("COPY --from=build");
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\\\n\s+CMD .*\/health/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["node", "packages\/cli\/bin\/wf\.js"\]$/m);
  });

  it("keeps the build context free of dependencies, secrets and state", () => {
    const ignored = read(".dockerignore").split("\n");
    for (const entry of ["**/node_modules", ".git", ".env", ".wf"]) {
      expect(ignored).toContain(entry);
    }
  });

  it("offers the image through a compose profile that waits for a healthy database", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/^ {2}engine:$/m);
    expect(compose).toContain("build: .");
    expect(compose).toContain("condition: service_healthy");
  });

  it("builds and smoke tests the image in CI", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toMatch(/^ {2}docker:$/m);
    expect(workflow).toContain("docker build -t dee:ci .");
    expect(workflow).toContain("run start payment-saga");
  });

  it("points the quick start at a module that defines the workflow it starts", () => {
    const readme = read("README.md");
    expect(readme).toContain(
      "npx wf dev --module examples/hello/src/index.ts --example payment-saga",
    );
    expect(readme).toContain("npx wf run start hello");
    expect(workflows.map((workflow) => workflow.workflowType)).toContain("hello");
  });

  it("uses only commands that wf help lists in the documents' wf examples", () => {
    const commands = new Set(
      HELP_TEXT.split("\n")
        .filter((line) => /^ {2}[a-z]/.test(line))
        .map((line) => line.trim().split(" ")[0]),
    );
    const used = new Set<string>();
    for (const document of DOCUMENTS) {
      for (const match of read(document).matchAll(/^(?:\$ )?(?:npx wf|wf) ([a-z]+)/gm)) {
        if (match[1] !== undefined) {
          used.add(match[1]);
        }
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(4);
    expect([...used].filter((command) => !commands.has(command))).toEqual([]);
  });

  it("only mentions files that exist", () => {
    const missing: string[] = [];
    for (const document of DOCUMENTS) {
      const text = read(document);
      for (const match of text.matchAll(
        /`((?:docs|packages|apps|examples|test)\/[^`\s*{}<>]+)`/g,
      )) {
        const target = match[1];
        if (target !== undefined && !existsSync(path.join(root, target))) {
          missing.push(`${document}: ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("lists every document under docs in the readme", () => {
    const readme = read("README.md");
    const unlisted = readdirSync(path.join(root, "docs"))
      .filter((name) => name.endsWith(".md"))
      .filter((name) => !readme.includes(`docs/${name}`));
    expect(unlisted).toEqual([]);
  });

  it("draws the architecture with balanced mermaid diagrams", () => {
    const architecture = read("docs/ARCHITECTURE.md");
    const fences = architecture.match(/^```/gm) ?? [];
    const diagrams = architecture.match(/^```mermaid$/gm) ?? [];
    expect(diagrams.length).toBeGreaterThanOrEqual(3);
    expect(fences.length % 2).toBe(0);
  });

  it("explains each concept the backlog names", () => {
    const concepts = read("docs/CONCEPTS.md");
    for (const heading of [
      "## Replay and determinism",
      "## Versioning",
      "## Steps, retries and dead letters",
      "## Idempotency",
    ]) {
      expect(concepts).toContain(heading);
    }
  });
});
