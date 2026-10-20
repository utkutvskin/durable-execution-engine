import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import {
  booleanFlag,
  parseCommand,
  parseJsonFlag,
  requirePositional,
  stringFlag,
  stringFlags,
} from "./shared.js";

describe("command argument parsing", () => {
  const spec = {
    module: { type: "string", multiple: true },
    port: { type: "string" },
    json: { type: "boolean" },
  } as const;

  it("collects positionals, repeated flags and booleans", () => {
    const parsed = parseCommand(["start", "--module", "a.ts", "--module=b.ts", "--json"], spec);
    expect(parsed.positionals).toEqual(["start"]);
    expect(stringFlags(parsed, "module")).toEqual(["a.ts", "b.ts"]);
    expect(booleanFlag(parsed, "json")).toBe(true);
    expect(stringFlag(parsed, "port")).toBeUndefined();
  });

  it("turns an unknown flag into a lowercase usage error with exit code 2", () => {
    expect(() => parseCommand(["--nope"], spec)).toThrow(CliError);
    let caught: unknown;
    try {
      parseCommand(["--nope"], spec);
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).exitCode).toBe(2);
    expect((caught as CliError).message).toBe((caught as CliError).message.toLowerCase());
  });

  it("names the missing positional argument", () => {
    const parsed = parseCommand([], spec);
    expect(() => requirePositional(parsed, 0, "run id")).toThrow("missing run id");
  });

  it("parses json flags and rejects invalid json", () => {
    expect(parseJsonFlag('{"a":1}', "input")).toEqual({ a: 1 });
    expect(parseJsonFlag(undefined, "input")).toBeUndefined();
    expect(() => parseJsonFlag("{oops", "input")).toThrow("--input is not valid json");
  });
});
