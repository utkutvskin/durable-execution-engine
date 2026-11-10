import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { PACKAGE_DIRECTORIES } from "./package-directories.mjs";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.resolve(process.argv[2] ?? path.join(root, ".packed"));

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

for (const directory of PACKAGE_DIRECTORIES) {
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: path.join(root, directory),
    stdio: "inherit",
  });
}

const tarballs = readdirSync(destination).filter((name) => name.endsWith(".tgz"));
process.stdout.write(`${tarballs.length} packages packed into ${destination}\n`);
