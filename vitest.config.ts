import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  ssr: {
    resolve: {
      conditions: ["development"],
      externalConditions: ["development"],
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
