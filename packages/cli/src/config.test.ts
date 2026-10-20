import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_API_URL,
  DEV_STATE_PATH,
  readDevState,
  resolveClientConfig,
  writeDevState,
} from "./config.js";
import { CliError } from "./errors.js";

describe("client configuration", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "wf-config-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("prefers flags over the environment over the dev state", () => {
    const devState = { apiUrl: "http://dev", apiKey: "dev-key", namespace: "default" };
    expect(
      resolveClientConfig({
        apiUrl: "http://flag",
        apiKey: "flag-key",
        env: { WF_API_URL: "http://env", WF_API_KEY: "env-key" },
        devState,
      }),
    ).toEqual({ apiUrl: "http://flag", apiKey: "flag-key" });
    expect(
      resolveClientConfig({ env: { WF_API_URL: "http://env", WF_API_KEY: "env-key" }, devState }),
    ).toEqual({ apiUrl: "http://env", apiKey: "env-key" });
    expect(resolveClientConfig({ env: {}, devState })).toEqual({
      apiUrl: "http://dev",
      apiKey: "dev-key",
    });
  });

  it("falls back to the default address and asks for a key when none is known", () => {
    expect(resolveClientConfig({ env: { WF_API_KEY: "k" } })).toEqual({
      apiUrl: DEFAULT_API_URL,
      apiKey: "k",
    });
    expect(() => resolveClientConfig({ env: {} })).toThrow(CliError);
    expect(() => resolveClientConfig({ env: {} })).toThrow("no api key");
  });

  it("round trips the dev state and creates its directory", async () => {
    const state = { apiUrl: "http://127.0.0.1:1", apiKey: "dee_abc", namespace: "default" };
    await writeDevState(directory, state);
    expect(await readDevState(directory)).toEqual(state);
  });

  it("treats a missing or malformed dev state file as absent", async () => {
    expect(await readDevState(directory)).toBeUndefined();
    await mkdir(path.join(directory, path.dirname(DEV_STATE_PATH)), { recursive: true });
    await writeFile(path.join(directory, DEV_STATE_PATH), "{not json", "utf8");
    expect(await readDevState(directory)).toBeUndefined();
    await writeFile(path.join(directory, DEV_STATE_PATH), '{"apiUrl":1}', "utf8");
    expect(await readDevState(directory)).toBeUndefined();
  });
});
