#!/usr/bin/env node
import { register } from "node:module";

if (process.features.typescript === false) {
  process.stderr.write("wf needs node 22.18 or newer (built in typescript support)\n");
  process.exit(1);
}
register("../src/runtime/resolve-hooks.ts", import.meta.url);
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
