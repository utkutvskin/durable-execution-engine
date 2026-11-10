import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_DIRECTORIES } from "./package-directories.mjs";
import { assertVersionMatchesTag, publishCommands, tarballName } from "./release-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [directoryArgument, tag, ...flags] = process.argv.slice(2);

if (directoryArgument === undefined || tag === undefined) {
  process.stderr.write(
    "usage: node scripts/publish-packages.mjs <packed-directory> <tag> [--dry-run]\n",
  );
  process.exit(2);
}

const dryRun = flags.includes("--dry-run");
const directory = path.resolve(directoryArgument);
const tarballs = PACKAGE_DIRECTORIES.map((packageDirectory) => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, packageDirectory, "package.json"), "utf8"),
  );
  assertVersionMatchesTag(tag, manifest.version);
  const tarball = path.join(directory, tarballName(manifest));
  if (!existsSync(tarball)) {
    throw new Error(`${tarball} is missing, run scripts/pack-packages.mjs first`);
  }
  return tarball;
});

for (const args of publishCommands({ tarballs, tag, dryRun })) {
  execFileSync("npm", args, { cwd: root, stdio: "inherit" });
}
