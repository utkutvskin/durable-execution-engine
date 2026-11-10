const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/**
 * Splits a release tag such as `v0.2.0` or `v0.2.0-rc.1` into its parts.
 * A tag with a pre-release suffix is a dry run: it publishes nothing.
 */
export function parseTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(
      `"${tag}" is not a release tag (expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-suffix)`,
    );
  }
  const base = `${match[1]}.${match[2]}.${match[3]}`;
  const prerelease = match[4] !== undefined;
  return {
    tag,
    version: prerelease ? `${base}-${match[4]}` : base,
    base,
    prerelease,
    npmTag: prerelease ? "next" : "latest",
  };
}

/**
 * Fails when the version a package carries is neither the tag version nor, for a pre-release tag, its base version.
 */
export function assertVersionMatchesTag(tag, version) {
  const parsed = parseTag(tag);
  const accepted = parsed.prerelease ? [parsed.version, parsed.base] : [parsed.version];
  if (!accepted.includes(version)) {
    throw new Error(`package version ${version} does not match tag ${tag}`);
  }
}

/**
 * Returns the body of the changelog section for a tag. A pre-release tag falls back to the section of its base version.
 */
export function extractReleaseNotes(changelog, tag) {
  const { version, base } = parseTag(tag);
  const lines = changelog.split("\n");
  for (const candidate of [version, base]) {
    const heading = lines.findIndex((line) => line.startsWith(`## [${candidate}]`));
    if (heading === -1) {
      continue;
    }
    const next = lines.findIndex((line, index) => index > heading && line.startsWith("## ["));
    const body = lines
      .slice(heading + 1, next === -1 ? lines.length : next)
      .join("\n")
      .trim();
    if (body === "") {
      throw new Error(`the changelog section for ${candidate} is empty`);
    }
    return `${body}\n`;
  }
  throw new Error(`the changelog has no section for ${version}`);
}

/**
 * The tarball file name pnpm gives a packed package.
 */
export function tarballName(manifest) {
  return `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
}

/**
 * The `npm publish` argument lists for the packed packages, in the order given.
 * Trusted publishing needs no token: the provenance flag makes npm exchange the workflow identity.
 */
export function publishCommands({ tarballs, tag, dryRun }) {
  const { npmTag } = parseTag(tag);
  return tarballs.map((tarball) => [
    "publish",
    tarball,
    "--access",
    "public",
    "--provenance",
    "--tag",
    npmTag,
    ...(dryRun ? ["--dry-run"] : []),
  ]);
}

/**
 * Decides what a workflow run does. A pushed tag releases for real unless it carries a pre-release suffix.
 * A manual dispatch is always a dry run and must name a pre-release tag.
 */
export function planRelease({ eventName, refName, inputTag }) {
  const tag = eventName === "workflow_dispatch" ? inputTag : refName;
  if (tag === undefined || tag === "") {
    throw new Error("no tag to release");
  }
  const parsed = parseTag(tag);
  if (eventName === "workflow_dispatch" && !parsed.prerelease) {
    throw new Error(`a manual run is a dry run and needs a pre-release tag, got ${tag}`);
  }
  return {
    tag,
    version: parsed.version,
    npmTag: parsed.npmTag,
    dryRun: parsed.prerelease || eventName === "workflow_dispatch",
  };
}
