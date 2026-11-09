import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const directory = path.resolve(process.argv[2] ?? path.join(root, ".packed"));
const tarballs = readdirSync(directory)
  .filter((name) => name.endsWith(".tgz"))
  .map((name) => path.join(directory, name));

let failed = false;

function run(label, command, args) {
  try {
    execFileSync(command, args, { cwd: root, stdio: "inherit" });
  } catch {
    failed = true;
    process.stderr.write(`${label} failed\n`);
  }
}

for (const tarball of tarballs) {
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  for (const required of ["package/LICENSE", "package/NOTICE", "package/package.json"]) {
    if (!listing.split("\n").includes(required)) {
      failed = true;
      process.stderr.write(`${path.basename(tarball)} has no ${required}\n`);
    }
  }
  run(`publint ${tarball}`, "pnpm", ["exec", "publint", "run", "--strict", tarball]);
  run(`attw ${tarball}`, "pnpm", ["exec", "attw", tarball, "--profile", "esm-only"]);
}

process.exitCode = failed ? 1 : 0;
