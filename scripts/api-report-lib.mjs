import path from "node:path";
import { readFileSync } from "node:fs";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

/**
 * The file name of the API report of `packageName`: `@dee/core` becomes
 * `dee-core.api.md`.
 */
export function reportFileName(packageName) {
  return `${packageName.replace(/^@/, "").replace("/", "-")}.api.md`;
}

function prepare(projectFolder, reportFolder, tempFolder) {
  const manifest = JSON.parse(readFileSync(path.join(projectFolder, "package.json"), "utf8"));
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder,
      mainEntryPointFilePath: "<projectFolder>/dist/index.d.ts",
      bundledPackages: [],
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: "es2023",
            lib: ["es2023"],
            module: "nodenext",
            moduleResolution: "nodenext",
            types: ["node"],
            strict: true,
            skipLibCheck: true,
          },
          files: ["dist/index.d.ts"],
        },
      },
      apiReport: {
        enabled: true,
        reportFileName: reportFileName(manifest.name),
        reportFolder,
        reportTempFolder: tempFolder,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
      messages: {
        compilerMessageReporting: { default: { logLevel: "warning" } },
        extractorMessageReporting: {
          default: { logLevel: "warning", addToApiReportFile: true },
          "ae-missing-release-tag": { logLevel: "none" },
        },
        tsdocMessageReporting: { default: { logLevel: "none" } },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: path.join(projectFolder, "package.json"),
  });
  return { name: manifest.name, config };
}

/**
 * Compares the built declarations of the package in `projectFolder`
 * (`dist/index.d.ts`) with its committed report in `reportFolder`. With
 * `update`, a changed report is written instead of failing.
 */
export function checkApiReport(projectFolder, options) {
  const { name, config } = prepare(projectFolder, options.reportFolder, options.tempFolder);
  const result = Extractor.invoke(config, {
    localBuild: options.update === true,
    showVerboseMessages: false,
    showDiagnostics: false,
    messageCallback: (message) => {
      message.handled = true;
    },
  });
  const changed = result.apiReportChanged;
  return {
    name,
    reportFile: reportFileName(name),
    changed,
    ok: options.update === true ? result.errorCount === 0 : !changed && result.errorCount === 0,
    errorCount: result.errorCount,
  };
}
