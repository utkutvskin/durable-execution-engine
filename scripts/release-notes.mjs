import { readFileSync } from "node:fs";
import path from "node:path";
import { extractReleaseNotes } from "./release-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [tag, changelogPath] = process.argv.slice(2);

if (tag === undefined) {
  process.stderr.write("usage: node scripts/release-notes.mjs <tag> [changelog]\n");
  process.exit(2);
}

const changelog = readFileSync(changelogPath ?? path.join(root, "CHANGELOG.md"), "utf8");
process.stdout.write(extractReleaseNotes(changelog, tag));
