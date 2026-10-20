import type { ResolveHook } from "node:module";

const PACKAGE_ENTRIES: Readonly<Record<string, string>> = {
  "@dee/core": "../../../core/src/index.ts",
  "@dee/worker": "../../../worker/src/index.ts",
  "@dee/api": "../../../api/src/index.ts",
  "@dee/ui": "../../../../apps/ui/src/index.ts",
  "@dee/cli": "../index.ts",
  "@dee/example-payment-saga": "../../../../examples/payment-saga/src/index.ts",
  "@dee/example-etl-pipeline": "../../../../examples/etl-pipeline/src/index.ts",
};

/**
 * Module resolution hook that lets Node run the workspace's TypeScript
 * sources directly: a `@dee/*` package resolves to its source entry and a
 * relative `.js` specifier falls back to its `.ts` sibling.
 */
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const entry = PACKAGE_ENTRIES[specifier];
  if (entry !== undefined) {
    return { url: new URL(entry, import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      return nextResolve(specifier, context);
    }
  }
  return nextResolve(specifier, context);
};
