import type { ResolveHook } from "node:module";

const coreEntry = new URL("../../../core/src/index.ts", import.meta.url).href;

/**
 * Module resolution hook for child processes that run the workspace's
 * TypeScript sources directly: `@dee/core` resolves to its source entry and
 * a relative `.js` specifier falls back to its `.ts` sibling.
 */
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  if (specifier === "@dee/core") {
    return { url: coreEntry, shortCircuit: true };
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
