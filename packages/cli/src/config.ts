import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";

/**
 * Where `wf dev` records how to reach the api it started, relative to the
 * directory it ran in. The run commands read it when no flag or environment
 * variable says otherwise.
 */
export const DEV_STATE_PATH = ".wf/dev.json";

/**
 * What `wf dev` writes to `DEV_STATE_PATH`.
 */
export interface DevState {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly namespace: string;
}

/**
 * Reads `DEV_STATE_PATH` under `cwd`; resolves `undefined` when the file is
 * missing or is not a dev state.
 */
export async function readDevState(cwd: string): Promise<DevState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(cwd, DEV_STATE_PATH), "utf8")) as Partial<
      Record<keyof DevState, unknown>
    >;
    if (
      typeof parsed.apiUrl === "string" &&
      typeof parsed.apiKey === "string" &&
      typeof parsed.namespace === "string"
    ) {
      return { apiUrl: parsed.apiUrl, apiKey: parsed.apiKey, namespace: parsed.namespace };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes `state` to `DEV_STATE_PATH` under `cwd`, creating the directory.
 */
export async function writeDevState(cwd: string, state: DevState): Promise<void> {
  const file = path.join(cwd, DEV_STATE_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Where and how the run commands reach the api.
 */
export interface ClientConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
}

/**
 * The address `wf dev` listens on when no port is given.
 */
export const DEFAULT_API_URL = "http://127.0.0.1:8080";

/**
 * Picks the api address and key: the flags win, then `WF_API_URL` and
 * `WF_API_KEY`, then the dev state. Throws a `CliError` that says what to
 * set when no key can be found.
 */
export function resolveClientConfig(input: {
  readonly apiUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly devState?: DevState | undefined;
}): ClientConfig {
  const apiUrl =
    input.apiUrl ?? input.env["WF_API_URL"] ?? input.devState?.apiUrl ?? DEFAULT_API_URL;
  const apiKey = input.apiKey ?? input.env["WF_API_KEY"] ?? input.devState?.apiKey;
  if (apiKey === undefined || apiKey === "") {
    throw new CliError(
      "no api key: pass --api-key, set WF_API_KEY or start the environment with `wf dev` in this directory",
    );
  }
  return { apiUrl, apiKey };
}
