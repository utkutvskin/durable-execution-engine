import { describe, expect, it } from "vitest";
import {
  databaseUrl,
  ensureDatabase,
  findComposeDirectory,
  type DatabaseEffects,
} from "./database.js";
import { CliError } from "./errors.js";

interface Calls {
  probes: number;
  composeStarts: number;
  pauses: number;
}

function fakeEffects(
  reachableAfter: number,
  composeExitCode = 0,
): { readonly effects: DatabaseEffects; readonly calls: Calls } {
  const calls: Calls = { probes: 0, composeStarts: 0, pauses: 0 };
  return {
    calls,
    effects: {
      reachable: () => {
        calls.probes += 1;
        return Promise.resolve(calls.probes > reachableAfter);
      },
      startCompose: () => {
        calls.composeStarts += 1;
        return Promise.resolve(composeExitCode);
      },
      pause: () => {
        calls.pauses += 1;
        return Promise.resolve();
      },
    },
  };
}

describe("ensureDatabase", () => {
  const url = "postgres://dee:dee@localhost:5432/dee";
  const log = (): void => undefined;

  it("does nothing when the database already answers", async () => {
    const { effects, calls } = fakeEffects(0);
    await ensureDatabase({ url, composeDirectory: "/repo", log, effects });
    expect(calls).toEqual({ probes: 1, composeStarts: 0, pauses: 0 });
  });

  it("starts the compose service and waits until the database answers", async () => {
    const { effects, calls } = fakeEffects(3);
    await ensureDatabase({ url, composeDirectory: "/repo", log, effects });
    expect(calls.composeStarts).toBe(1);
    expect(calls.pauses).toBe(2);
  });

  it("explains what to do when there is no compose file", async () => {
    const { effects } = fakeEffects(99);
    await expect(
      ensureDatabase({ url, composeDirectory: undefined, log, effects }),
    ).rejects.toThrow(/set DATABASE_URL/);
  });

  it("fails when docker compose fails", async () => {
    const { effects } = fakeEffects(99, 1);
    await expect(
      ensureDatabase({ url, composeDirectory: "/repo", log, effects }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("gives up when the started database never answers", async () => {
    const { effects, calls } = fakeEffects(999);
    await expect(
      ensureDatabase({ url, composeDirectory: "/repo", log, effects, attempts: 3 }),
    ).rejects.toThrow("did not accept connections");
    expect(calls.pauses).toBe(3);
  });

  it("finds the compose directory above a working directory", () => {
    expect(findComposeDirectory(import.meta.dirname)).toBeDefined();
    expect(findComposeDirectory("/")).toBeUndefined();
  });

  it("prefers the flag over the environment for the database url", () => {
    expect(databaseUrl("postgres://flag", { DATABASE_URL: "postgres://env" })).toBe(
      "postgres://flag",
    );
    expect(databaseUrl(undefined, { DATABASE_URL: "postgres://env" })).toBe("postgres://env");
  });
});
