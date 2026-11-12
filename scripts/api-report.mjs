import path from "node:path";
import { checkApiReport } from "./api-report-lib.mjs";
import { PACKAGE_DIRECTORIES } from "./package-directories.mjs";

const root = path.resolve(import.meta.dirname, "..");
const update = process.argv.includes("--update");

let failed = 0;
for (const directory of PACKAGE_DIRECTORIES) {
  const result = checkApiReport(path.join(root, directory), {
    reportFolder: path.join(root, "api-reports"),
    tempFolder: path.join(root, "node_modules", ".api-report", directory),
    update,
  });
  if (result.ok) {
    process.stdout.write(`${result.name}: ${result.changed ? "report updated" : "unchanged"}\n`);
    continue;
  }
  failed += 1;
  process.stderr.write(
    result.changed
      ? `${result.name}: the public API changed. Review the difference, run \`pnpm run api:update\` ` +
          `and commit api-reports/${result.reportFile}\n`
      : `${result.name}: api-extractor reported ${String(result.errorCount)} errors\n`,
  );
}
process.exitCode = failed === 0 ? 0 : 1;
