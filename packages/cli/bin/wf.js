#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const built = new URL("../dist/main.js", import.meta.url);

if (existsSync(built)) {
  const { main } = await import(built.href);
  process.exitCode = await main(process.argv.slice(2));
} else {
  if (process.features.typescript === false) {
    process.stderr.write("wf needs node 22.18 or newer (built in typescript support)\n");
    process.exit(1);
  }
  const source = fileURLToPath(new URL("../src/run.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--conditions=development", source, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128);
  });
}
