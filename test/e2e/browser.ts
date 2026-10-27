import { existsSync } from "node:fs";

/** Where the Chromium binary is expected when `PLAYWRIGHT_CHROMIUM_PATH` is unset. */
export const DEFAULT_CHROMIUM_PATH = "/opt/pw-browsers/chromium";

/** What the browser test does on this machine: `run`, `skip` with a message, or `fail` with a message. */
export type BrowserPlan =
  | { readonly mode: "run"; readonly path: string }
  | { readonly mode: "skip" | "fail"; readonly path: string; readonly message: string };

/** Inputs of `planBrowser`, injectable so the decision is testable. */
export interface BrowserEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => boolean;
}

/**
 * Decides whether the browser test runs. A missing browser skips the test
 * with a message locally and fails it when `CI` is `true`, so CI never
 * skips it silently.
 */
export function planBrowser(environment: BrowserEnvironment): BrowserPlan {
  const path = environment.env["PLAYWRIGHT_CHROMIUM_PATH"] ?? DEFAULT_CHROMIUM_PATH;
  const exists = environment.exists ?? existsSync;
  if (exists(path)) {
    return { mode: "run", path };
  }
  const message = `no browser at ${path}, set PLAYWRIGHT_CHROMIUM_PATH to a Chromium binary`;
  return { mode: environment.env["CI"] === "true" ? "fail" : "skip", path, message };
}
