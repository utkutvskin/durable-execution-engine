import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dee/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@dee/worker": fileURLToPath(new URL("./packages/worker/src/index.ts", import.meta.url)),
      "@dee/api": fileURLToPath(new URL("./packages/api/src/index.ts", import.meta.url)),
      "@dee/ui": fileURLToPath(new URL("./apps/ui/src/index.ts", import.meta.url)),
      "@dee/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
      "@dee/example-payment-saga": fileURLToPath(
        new URL("./examples/payment-saga/src/index.ts", import.meta.url),
      ),
      "@dee/example-etl-pipeline": fileURLToPath(
        new URL("./examples/etl-pipeline/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: [
      "test/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "examples/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**", "apps/*/src/**", "examples/*/src/**"],
    },
  },
});
